# 通勤遅延アラーム（iPhone・Mac不要版）

通勤ルートがいつもより時間がかかりそうな朝だけ、iPhoneのアラームを自動でONにして早めに起こす仕組みです。

```
 iPhone ショートカット（平日 5:30 / 5:45 / 6:00 に自動実行）
        │  GET /check?key=合言葉
        ▼
 遅延チェック用サーバー（Cloudflare Workers・無料枠）
        ├─ 電車の運行情報 …… 公共交通オープンデータ（ODPT）
        ├─ 車・バスの渋滞 …… Google Routes API（使う場合だけ）
        └─ 天気 ………………… Open-Meteo（キー不要）
        │
        ▼  {"action":"on","alarmLabel":"遅延 6:20", ...}
 iPhone：「遅延 6:20」のアラームをON ＋ 通知
```

Mac・Xcode・Apple Developer Program は不要です。iPhoneとブラウザだけで設定できます。

---

## 1. 準備するもの

| もの | 用途 | 費用 |
|---|---|---|
| Cloudflare アカウント | サーバーを動かす | 無料（1日10万回まで） |
| 公共交通オープンデータ（ODPT）の開発者登録 | 東京メトロなどの運行情報 | 無料（承認に数日かかることがあります） |
| Google Cloud の Routes API キー | 車・バス区間の渋滞 | 使う場合のみ。毎月の無料枠あり |

- ODPT の登録：<https://developer.odpt.org/>
- 都営地下鉄は登録なしの公開APIで取れます（`"endpoint": "public"`）。
- **JR東日本・私鉄**は、ODPT で運行情報を出しているかどうかが事業者ごとに違います。登録後、ODPT の「データ一覧」で `odpt:TrainInformation` があるか確認してください。無い路線は今のところ自動では取れません（下の「制限」を参照）。

## 2. 通勤ルートの設定を書く

`config.example.json` をコピーして、自分の通勤に合わせて書き換えます。

| 項目 | 意味 | 例 |
|---|---|---|
| `usualAlarm` | いつものアラーム | `"06:42"` |
| `arriveBy` | 着きたい時刻 | `"09:00"` |
| `usualMinutes` | いつもの所要時間（分） | `52` |
| `thresholdMinutes` | これ以上遅れたら早める | `10` |
| `maxShiftMinutes` | 最大でどれだけ早めるか | `40` |
| `bucketMinutes` | アラームの刻み（10分なら 6:00, 6:10…） | `10` |
| `origin` / `destination` | Googleマップ用の出発地・到着地 | `"中野区本町"` |
| `trains` | 監視する路線（下の表） | |
| `roads` | 車・バス区間（任意） | |
| `weather` | 天気を見る場所と時間帯 | |

### 路線（`trains`）の書き方

```json
{ "name": "東西線", "operator": "odpt.Operator:TokyoMetro", "railway": "odpt.Railway:TokyoMetro.Tozai" }
```

よく使う例：

| 路線 | operator | railway |
|---|---|---|
| 東京メトロ 東西線 | `odpt.Operator:TokyoMetro` | `odpt.Railway:TokyoMetro.Tozai` |
| 東京メトロ 丸ノ内線 | `odpt.Operator:TokyoMetro` | `odpt.Railway:TokyoMetro.Marunouchi` |
| 東京メトロ 銀座線 | `odpt.Operator:TokyoMetro` | `odpt.Railway:TokyoMetro.Ginza` |
| 都営 大江戸線 | `odpt.Operator:Toei` | `odpt.Railway:Toei.Oedo`（`"endpoint": "public"` を付ける） |
| JR東日本 中央線快速 | `odpt.Operator:JR-East` | `odpt.Railway:JR-East.ChuoRapid`（ODPTで提供されている場合） |

遅れの分数は、運行情報の文に「約20分の遅れ」などがあればその数字を使います。書かれていない場合は「遅延＝15分」「運転見合わせ＝30分」として扱います（`trainDefaults` で変更できます）。

### 車・バス区間（`roads`、任意）

```json
{ "name": "環七（バス）", "mode": "bus", "origin": "中野区本町", "destination": "新中野駅", "toleranceMinutes": 2 }
```

渋滞ありと渋滞なしの所要時間の差を、遅れとして足します。

## 3. サーバーを動かす（ブラウザだけでOK）

1. Cloudflare にログイン →「Workers & Pages」→「作成」→「Worker を作成」→ 名前を `commute-delay-alarm` にしてデプロイ。
2. 「コードを編集」を開き、中身を全部消して `src/worker.js` の内容を貼り付け →「デプロイ」。
   （GitHub リポジトリをつなぐ「Workers Builds」を使えば、push するだけで自動で更新されます。）
3. Worker の「設定」→「変数とシークレット」に次を追加：
   - `CONFIG`（テキスト）… 手順2で書いた JSON をそのまま貼る
   - `ACCESS_KEY`（シークレット）… 長めの合言葉（例：ランダムな英数字20文字）
   - `ODPT_TOKEN`（シークレット）… ODPT のアクセストークン
   - `GOOGLE_MAPS_KEY`（シークレット）… `roads` を使う場合だけ
4. ブラウザで次を開いて動作確認：
   - `https://commute-delay-alarm.<あなたのサブドメイン>.workers.dev/check?key=<合言葉>` … 今の判定結果
   - `.../presets?key=<合言葉>` … iPhone に事前に作っておくアラームの一覧

`/check` が返す主な値：

| キー | 例 | 意味 |
|---|---|---|
| `action` | `on` / `off` / `now` | ショートカットがすること |
| `alarmLabel` | `遅延 6:20` | ONにするアラームの名前 |
| `extraMinutes` | `18` | いつもより何分遅れそうか |
| `title` / `message` | | 通知に出す文 |
| `mapsUrl` | | Googleマップで自宅→会社を開くURL |
| `errors` | `[]` | 取れなかった情報（空でなければ要確認） |

## 4. iPhone のショートカットを作る

→ [docs/shortcut.md](docs/shortcut.md)

## 判定のルール

1. 電車・道路・天気の遅れを足して「いつもより何分」を出す。
2. `thresholdMinutes` 以上なら、その分だけアラームを早める（最大 `maxShiftMinutes`）。
3. 時刻は `bucketMinutes` 単位で切り下げ（6:24 → 「遅延 6:20」）。
4. すでに過ぎた時刻は選ばず、次の枠にする。間に合う枠がなければ `action: "now"`（すぐ通知）。
5. 遅れが解消したら `action: "off"`（遅延アラームをOFF、いつものアラームだけ残る）。

## 制限

- JR東日本・私鉄で ODPT に運行情報が無い路線は、今は自動で取れません。運行情報サイトの画面を読み取る方法は各サイトの利用規約に触れるおそれがあるため、入れていません。
- データ取得に失敗した場合は「いつも通り」と判定し、`errors` に理由が入ります。ショートカット側で `errors` が空でなければ通知するようにしています。
- iPhone の「時刻」オートメーションは、まれに遅れて実行されることがあります。そのため3回に分けてチェックします。

## テスト

```bash
npm test
```
