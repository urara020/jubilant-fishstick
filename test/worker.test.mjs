import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { check, decide, interpretTrainInfo, normalizeConfig, presetAlarms } from '../src/worker.js';
import { readFileSync } from 'node:fs';

const config = normalizeConfig(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url))));
const defaults = config.trainDefaults;
// 2026-11-09 05:58 JST
const now = new Date('2026-11-08T20:58:00Z');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [pattern, body] of routes) {
      if (String(url).includes(pattern)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

function weatherBody(rain) {
  const time = [];
  const precipitation = [];
  for (let h = 0; h < 24; h++) {
    time.push(`2026-11-09T${String(h).padStart(2, '0')}:00`);
    precipitation.push(h === 8 ? rain : 0);
  }
  return { hourly: { time, precipitation, snowfall: time.map(() => 0) } };
}

const metroNormal = [
  { 'odpt:railway': 'odpt.Railway:TokyoMetro.Tozai', 'odpt:trainInformationText': { ja: '平常どおり運転しています。' } },
  { 'odpt:railway': 'odpt.Railway:TokyoMetro.Marunouchi', 'odpt:trainInformationText': { ja: '平常どおり運転しています。' } },
];
const metroDelay = [
  { 'odpt:railway': 'odpt.Railway:TokyoMetro.Tozai', 'odpt:trainInformationStatus': { ja: '遅延' }, 'odpt:trainInformationText': { ja: '信号確認の影響で、最大15分程度の遅れが出ています。' } },
  metroNormal[1],
];
const toeiNormal = [{ 'odpt:railway': 'odpt.Railway:Toei.Oedo', 'odpt:trainInformationText': { ja: '現在、平常どおり運転しています。' } }];

test('いつも通りなら normal・アラームはそのまま', async () => {
  const f = fakeFetch([['TokyoMetro', metroNormal], ['Toei', toeiNormal], ['open-meteo', weatherBody(0)]]);
  const r = await check(config, { ODPT_TOKEN: 't' }, { now, fetchImpl: f });
  assert.equal(r.status, 'normal');
  assert.equal(r.action, 'off');
  assert.equal(r.alarmTime, '06:42');
  assert.deepEqual(r.errors, []);
  assert.equal(r.checkedAt, '2026-11-09 05:58');
});

test('東西線15分遅れ＋雨3分 → 18分早めて 6:20 の遅延アラーム', async () => {
  const f = fakeFetch([['TokyoMetro', metroDelay], ['Toei', toeiNormal], ['open-meteo', weatherBody(2.5)]]);
  const r = await check(config, { ODPT_TOKEN: 't' }, { now, fetchImpl: f });
  assert.equal(r.status, 'delay');
  assert.equal(r.action, 'on');
  assert.equal(r.extraMinutes, 18);
  assert.equal(r.alarmTime, '06:20');
  assert.equal(r.alarmLabel, '遅延 6:20');
  assert.equal(r.leaveBy, '07:50');
  assert.equal(r.reasons.length, 2);
  // 東京メトロは 1 回だけ取得、都営はキー不要の公開 API
  assert.equal(f.calls.filter((u) => u.includes('TokyoMetro')).length, 1);
  assert.ok(f.calls.find((u) => u.includes('Toei')).startsWith('https://api-public.odpt.org/'));
  assert.ok(!f.calls.find((u) => u.includes('Toei')).includes('consumerKey'));
});

test('運転見合わせは既定の30分として扱う', () => {
  const t = interpretTrainInfo({ name: '東西線' }, { 'odpt:trainInformationStatus': { ja: '運転見合わせ' }, 'odpt:trainInformationText': { ja: '人身事故の影響で運転を見合わせています。' } }, defaults);
  assert.equal(t.extraMinutes, 30);
  assert.equal(t.suspended, true);
});

test('時刻（10時15分頃）を遅れの分数と取り違えない', () => {
  const t = interpretTrainInfo({ name: 'X' }, { 'odpt:trainInformationStatus': { ja: '遅延' }, 'odpt:trainInformationText': { ja: '10時15分頃、車両点検のため遅れが出ています。' } }, defaults);
  assert.equal(t.extraMinutes, 15); // 既定値（文中の 15分 は時刻なので使わない）
  const t2 = interpretTrainInfo({ name: 'X' }, { 'odpt:trainInformationStatus': { ja: '遅延' }, 'odpt:trainInformationText': { ja: '7時05分頃の影響で、約25分の遅れが出ています。' } }, defaults);
  assert.equal(t2.extraMinutes, 25);
});

test('しきい値未満は normal、上限を超える遅れは maxShift で止める', () => {
  const small = decide(config, { extra: 9, reasons: [], suspended: false, errors: [], now });
  assert.equal(small.status, 'normal');
  const big = decide(config, { extra: 90, reasons: [], suspended: true, errors: [], now });
  assert.equal(big.alarmTime, '06:00');
});

test('過ぎた時刻は選ばない：6:12 に見つけたら 6:20、6:35 なら今すぐ通知', () => {
  const at612 = new Date('2026-11-08T21:12:00Z');
  const r1 = decide(config, { extra: 40, reasons: [], suspended: false, errors: [], now: at612 });
  assert.equal(r1.action, 'on');
  assert.equal(r1.alarmLabel, '遅延 6:20');
  const at635 = new Date('2026-11-08T21:35:00Z');
  const r2 = decide(config, { extra: 40, reasons: [], suspended: false, errors: [], now: at635 });
  assert.equal(r2.action, 'now');
  assert.equal(r2.alarmLabel, '');
});

test('事前に作るアラームの一覧', () => {
  assert.deepEqual(presetAlarms(config).map((p) => p.label), ['遅延 6:00', '遅延 6:10', '遅延 6:20', '遅延 6:30']);
});

test('データが取れなくても止まらず errors に入れる', async () => {
  const f = fakeFetch([['open-meteo', weatherBody(0)]]);
  const r = await check(config, {}, { now, fetchImpl: f });
  assert.equal(r.status, 'normal');
  assert.equal(r.errors.length, 1);
});

test('合言葉が違えば 401', async () => {
  const res = await worker.fetch(new Request('https://x.example/check?key=wrong'), { ACCESS_KEY: 'right', CONFIG: '{}' });
  assert.equal(res.status, 401);
});

test('simulate で遅延を試せる', async () => {
  const res = await worker.fetch(new Request('https://x.example/check?key=k&simulate=20'), { ACCESS_KEY: 'k', CONFIG: readFileSync(new URL('../config.example.json', import.meta.url), 'utf8') });
  const body = await res.json();
  assert.equal(body.status, 'delay');
  assert.equal(body.extraMinutes, 20);
});

test('ACCESS_KEY 未設定と不一致を区別し、前後の空白は無視する', async () => {
  const cfg = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8');
  const missing = await (await worker.fetch(new Request('https://x.example/presets?key=a'), { CONFIG: cfg })).json();
  assert.match(missing.reason, /設定されていません/);
  const ok = await worker.fetch(new Request('https://x.example/presets?key=abc'), { ACCESS_KEY: ' abc\n', CONFIG: cfg });
  assert.equal(ok.status, 200);
});
