// 通勤遅延アラーム — 遅延チェック用サーバー（Cloudflare Workers）
//
// iPhone のショートカットから GET /check?key=... で呼び出すと、
// 今朝の通勤が「いつも」より何分遅れそうかを調べて、
// どのアラームを ON にすればよいかを JSON で返します。
//
// 必要な設定（Cloudflare のダッシュボード > Worker > 設定 > 変数とシークレット）
//   CONFIG          … 通勤ルートの設定（JSON 文字列。config.example.json を参照）
//   ACCESS_KEY      … ショートカットから呼ぶときの合言葉（シークレット）
//   ODPT_TOKEN      … 公共交通オープンデータのアクセストークン（東京メトロなどに必要）
//   GOOGLE_MAPS_KEY … 車・バス区間の渋滞を調べる場合だけ必要（Routes API）

const JST_OFFSET_MIN = 9 * 60;

const ODPT_BASE = {
  member: 'https://api.odpt.org/api/v4',
  public: 'https://api-public.odpt.org/api/v4',
  challenge: 'https://api-challenge.odpt.org/api/v4',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, name: 'commute-delay-alarm' });
    }
    const expected = String(env.ACCESS_KEY || '').trim();
    if (!expected) {
      return json({ error: 'unauthorized', reason: 'サーバーに ACCESS_KEY が設定されていません（ビルド用ではなく、Worker 本体の「変数とシークレット」に入れてください）' }, 401);
    }
    if (String(url.searchParams.get('key') || '').trim() !== expected) {
      return json({ error: 'unauthorized', reason: '合言葉が一致しません' }, 401);
    }
    let config;
    try {
      config = normalizeConfig(JSON.parse(env.CONFIG || '{}'));
    } catch (e) {
      return json({ error: 'CONFIG が正しい JSON ではありません: ' + e.message }, 500);
    }
    if (url.pathname === '/presets') {
      return json({ presets: presetAlarms(config) });
    }
    if (url.pathname === '/check') {
      // 動作確認用: /check?key=...&simulate=20 で「20分遅れ」として判定
      const simulate = Number(url.searchParams.get('simulate'));
      if (simulate > 0) {
        const reasons = [{ kind: 'test', label: 'テスト', text: `テスト：+${simulate}分`, minutes: simulate }];
        return json(decide(config, { extra: simulate, reasons, suspended: false, errors: [], now: new Date() }));
      }
      const result = await check(config, env, { now: new Date(), fetchImpl: fetch });
      return json(result);
    }
    return json({ error: 'not found' }, 404);
  },
};

// ---------- 判定の本体 ----------

export async function check(config, env, { now, fetchImpl }) {
  const reasons = [];
  const errors = [];
  let extra = 0;
  let suspended = false;

  const trains = await checkTrains(config, env, fetchImpl).catch((e) => {
    errors.push('電車: ' + e.message);
    return [];
  });
  for (const t of trains) {
    if (t.extraMinutes > 0) {
      extra += t.extraMinutes;
      reasons.push({ kind: 'train', label: '電車', text: `${t.name}：${t.text}`, minutes: t.extraMinutes });
    }
    if (t.suspended) suspended = true;
  }

  const roads = await checkRoads(config, env, fetchImpl).catch((e) => {
    errors.push('道路: ' + e.message);
    return [];
  });
  for (const r of roads) {
    if (r.extraMinutes > 0) {
      extra += r.extraMinutes;
      reasons.push({ kind: 'road', label: r.mode === 'bus' ? 'バス' : '車', text: `${r.name}：渋滞 +${r.extraMinutes}分`, minutes: r.extraMinutes });
    }
  }

  const weather = await checkWeather(config, now, fetchImpl).catch((e) => {
    errors.push('天気: ' + e.message);
    return null;
  });
  if (weather && weather.extraMinutes > 0) {
    extra += weather.extraMinutes;
    reasons.push({ kind: 'weather', label: '天気', text: weather.text, minutes: weather.extraMinutes });
  }

  return decide(config, { extra, reasons, suspended, errors, now });
}

export function decide(config, { extra, reasons, suspended, errors, now }) {
  const usual = parseHM(config.usualAlarm);
  const isDelay = extra >= config.thresholdMinutes;
  const shift = isDelay ? Math.min(extra, config.maxShiftMinutes) : 0;
  let alarmMin = floorTo(usual - shift, config.bucketMinutes);
  // すでに過ぎた時刻のアラームを ON にすると翌朝に鳴ってしまうので、
  // 今より後の時刻に繰り下げる。間に合う枠がなければ「今すぐ通知」にする。
  const nowMin = jstMinutes(now);
  let wakeNow = false;
  if (isDelay && alarmMin <= nowMin) {
    const later = presetAlarms(config).map((p) => parseHM(p.time)).find((m) => m > nowMin);
    if (later === undefined) wakeNow = true;
    else alarmMin = later;
  }
  const alarm = isDelay ? (wakeNow ? formatHM(nowMin) : formatHM(alarmMin)) : config.usualAlarm;
  const arrive = parseHM(config.arriveBy);
  const leave = arrive - config.usualMinutes - shift;

  const reasonText = reasons.map((r) => r.text).join(' / ');
  const message = isDelay
    ? `いつもより +${extra}分。${wakeNow ? '今すぐ起きてください。' : `アラームを ${alarm} に早めます。`}${reasonText}`
    : `いつも通り（+${extra}分）。アラームは ${config.usualAlarm} のままです。`;

  return {
    status: isDelay ? 'delay' : 'normal',
    // ショートカット側の動作:
    //   on  = alarmLabel の遅延アラームを ON（ほかの遅延アラームは OFF）
    //   off = 遅延アラームをすべて OFF
    //   now = 間に合うアラーム枠がないので、すぐに通知する
    action: isDelay ? (wakeNow ? 'now' : 'on') : 'off',
    extraMinutes: extra,
    thresholdMinutes: config.thresholdMinutes,
    alarmTime: alarm,
    alarmLabel: isDelay && !wakeNow ? labelFor(alarm, config) : '',
    usualAlarm: config.usualAlarm,
    leaveBy: formatHM(leave),
    suspended,
    title: !isDelay ? '通勤ルートはいつも通りです'
      : wakeNow ? `遅延を検知：いつもより +${extra}分です` : `遅延を検知：アラームを${alarm}に早めます`,
    message,
    reasons,
    mapsUrl: mapsUrl(config),
    checkedAt: formatJst(now),
    errors,
  };
}

// ---------- 電車（公共交通オープンデータ） ----------

export async function checkTrains(config, env, fetchImpl) {
  if (!config.trains.length) return [];
  // 同じ API・同じ事業者はまとめて 1 回で取得
  const groups = new Map();
  for (const line of config.trains) {
    const base = line.baseUrl || ODPT_BASE[line.endpoint || 'member'];
    const k = base + '|' + line.operator;
    if (!groups.has(k)) groups.set(k, { base, operator: line.operator, lines: [] });
    groups.get(k).lines.push(line);
  }
  const out = [];
  for (const g of groups.values()) {
    const q = new URLSearchParams({ 'odpt:operator': g.operator });
    if (!g.base.includes('api-public')) {
      if (!env.ODPT_TOKEN) throw new Error('ODPT_TOKEN が未設定です');
      q.set('acl:consumerKey', env.ODPT_TOKEN);
    }
    const res = await fetchImpl(`${g.base}/odpt:TrainInformation?${q}`);
    if (!res.ok) throw new Error(`${g.operator} の取得に失敗（${res.status}）`);
    const items = await res.json();
    for (const line of g.lines) {
      const info = items.find((it) => it['odpt:railway'] === line.railway)
        || items.find((it) => !it['odpt:railway']); // 事業者全体のお知らせ
      out.push(interpretTrainInfo(line, info, config.trainDefaults));
    }
  }
  return out;
}

export function interpretTrainInfo(line, info, defaults) {
  const status = textOf(info && info['odpt:trainInformationStatus']);
  const text = textOf(info && info['odpt:trainInformationText']) || '情報なし';
  const all = status + ' ' + text;
  const normal = !status && /平常|通常|遅れはありません/.test(text);
  if (!info || normal) return { name: line.name, text: '平常運転', extraMinutes: 0, suspended: false };

  const suspended = /見合わせ|運休|運転を中止/.test(all);
  const m = all.match(/(?:約|最大)?\s*(\d{1,3})\s*分(?:程度|以上|前後)?の?(?:遅れ|遅延)/);
  let minutes;
  if (m) minutes = Number(m[1]);
  else if (suspended) minutes = defaults.suspendedMinutes;
  else if (/遅れ|遅延|ダイヤが乱れ|運転再開/.test(all)) minutes = defaults.delayMinutes;
  else minutes = 0; // 「お知らせ」など遅れに関係ない情報
  return { name: line.name, text: shorten(status ? `${status}（${text}）` : text), extraMinutes: minutes, suspended };
}

// ---------- 車・バス（Google Routes API） ----------

export async function checkRoads(config, env, fetchImpl) {
  if (!config.roads.length) return [];
  if (!env.GOOGLE_MAPS_KEY) throw new Error('GOOGLE_MAPS_KEY が未設定です');
  const out = [];
  for (const road of config.roads) {
    const res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.staticDuration',
      },
      body: JSON.stringify({
        origin: { address: road.origin },
        destination: { address: road.destination },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        languageCode: 'ja',
      }),
    });
    if (!res.ok) throw new Error(`${road.name} の取得に失敗（${res.status}）`);
    const data = await res.json();
    const r = data.routes && data.routes[0];
    if (!r) continue;
    const withTraffic = seconds(r.duration);
    const noTraffic = seconds(r.staticDuration);
    const extraMinutes = Math.max(0, Math.round((withTraffic - noTraffic) / 60) - (road.toleranceMinutes || 0));
    out.push({ name: road.name, mode: road.mode || 'car', extraMinutes });
  }
  return out;
}

// ---------- 天気（Open-Meteo・キー不要） ----------

export async function checkWeather(config, now, fetchImpl) {
  const w = config.weather;
  if (!w) return null;
  const q = new URLSearchParams({
    latitude: String(w.lat),
    longitude: String(w.lon),
    hourly: 'precipitation,snowfall',
    timezone: 'Asia/Tokyo',
    forecast_days: '1',
  });
  const res = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!res.ok) throw new Error(`取得に失敗（${res.status}）`);
  const data = await res.json();
  const today = formatJst(now).slice(0, 10);
  let rain = 0;
  let snow = 0;
  (data.hourly.time || []).forEach((t, i) => {
    const hour = Number(t.slice(11, 13));
    if (t.slice(0, 10) === today && w.hours.includes(hour)) {
      rain = Math.max(rain, data.hourly.precipitation[i] || 0);
      snow = Math.max(snow, (data.hourly.snowfall && data.hourly.snowfall[i]) || 0);
    }
  });
  if (snow >= 0.5) return { text: `通勤時間帯に雪（${snow}cm/時）`, extraMinutes: w.snowExtraMinutes };
  if (rain >= w.rainThresholdMm) return { text: `通勤時間帯に雨（${rain}mm/時）`, extraMinutes: w.rainExtraMinutes };
  return { text: '天気の影響なし', extraMinutes: 0 };
}

// ---------- 設定・補助 ----------

export function normalizeConfig(c) {
  const cfg = {
    usualAlarm: c.usualAlarm || '06:40',
    arriveBy: c.arriveBy || '09:00',
    usualMinutes: num(c.usualMinutes, 50),
    thresholdMinutes: num(c.thresholdMinutes, 10),
    maxShiftMinutes: num(c.maxShiftMinutes, 40),
    bucketMinutes: num(c.bucketMinutes, 10),
    alarmLabelPrefix: c.alarmLabelPrefix || '遅延',
    origin: c.origin || '',
    destination: c.destination || '',
    trains: Array.isArray(c.trains) ? c.trains : [],
    roads: Array.isArray(c.roads) ? c.roads : [],
    trainDefaults: Object.assign({ delayMinutes: 15, suspendedMinutes: 30 }, c.trainDefaults),
    weather: c.weather
      ? Object.assign({ hours: [7, 8, 9], rainThresholdMm: 1, rainExtraMinutes: 3, snowExtraMinutes: 10 }, c.weather)
      : null,
  };
  parseHM(cfg.usualAlarm);
  parseHM(cfg.arriveBy);
  return cfg;
}

// ショートカット用に事前に作っておくアラームの一覧（例: 遅延 6:00, 遅延 6:10, ...）
export function presetAlarms(config) {
  const usual = parseHM(config.usualAlarm);
  const first = floorTo(usual - config.maxShiftMinutes, config.bucketMinutes);
  const last = floorTo(usual - config.thresholdMinutes, config.bucketMinutes);
  const list = [];
  for (let m = first; m <= last; m += config.bucketMinutes) {
    const t = formatHM(m);
    list.push({ time: t, label: labelFor(t, config) });
  }
  return list;
}

function labelFor(hm, config) {
  return `${config.alarmLabelPrefix} ${hm.replace(/^0/, '')}`;
}

export function mapsUrl(config) {
  const q = new URLSearchParams({ api: '1', origin: config.origin, destination: config.destination, travelmode: 'transit' });
  return `https://www.google.com/maps/dir/?${q}`;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`時刻の形式が違います: ${s}（例: 06:40）`);
  return Number(m[1]) * 60 + Number(m[2]);
}
function formatHM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function floorTo(min, step) {
  return Math.floor(min / step) * step;
}
function jstMinutes(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MIN * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function formatJst(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MIN * 60000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function textOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.ja || v.en || '';
}
function shorten(s) {
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}
function seconds(s) {
  return Number(String(s || '0').replace(/s$/, '')) || 0;
}
function num(v, d) {
  return typeof v === 'number' && isFinite(v) ? v : d;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
