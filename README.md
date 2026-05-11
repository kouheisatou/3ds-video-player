# 3DS 3D Media Studio

ニンテンドー3DSで撮影した **3D動画 (.AVI)** と **3D写真 (.MPO)** をブラウザで再生・変換・編集できる、シンプルな静的サイト。

すべての処理はブラウザ内で完結し、ファイルはサーバに送信されません。

## 機能

- **読み込み**: D&D で `.AVI` / `.MPO` を複数同時投入
- **プレビュー**: 2D / SBS(サイドバイサイド)切替で再生・表示
- **変換キュー**: 複数ファイルをまとめて変換、進捗表示、個別ダウンロード
- **出力フォーマット**:
  - 動画: MP4 (H.264 + AAC) — 2D左/右、SBS、Top/Bottom、アナグリフ赤青
  - 画像: JPEG または MPO 再パック(同上の3Dモード対応)
- **調整(per file)**: 回転 (0/90/180/270°) / 反転 / 左右入替 / 明度 / コントラスト / 彩度 / ガンマ / 色相
- **共通設定(queue-wide)**: 出力フォーマット / JPEG品質 / 動画ビットレート
- **EXIF 編集**: 日時 / Make / Model / Software / 説明 / 作者 / 著作権 / 向き / GPS
  3DS固有の MakerNote (Parallax / Model ID 等) は読み取り専用で表示・保持

## 動作要件

- **WebCodecs API** 対応ブラウザ(動画変換のため)
  - Chrome 94+ / Edge 94+
  - Safari 16.4+
  - Firefox 130+
- WebGL2 対応(全環境)

## ローカル実行

```bash
cd 3ds-video-player
python3 -m http.server 8765
# → http://localhost:8765/
```

## GitHub Pages デプロイ

1. リポジトリ作成して全ファイルを push
2. **Settings → Pages → Source: `main` / `(root)`**
3. `.nojekyll` は同梱済み(`_` 始まりファイルが無効化されないよう)
4. デプロイ後 URL でアクセス

## Google Analytics 4 設定

`index.html` の以下2箇所の `G-XXXXXXXXXX` を、あなたの GA4 測定 ID に置換してください。

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  ...
  gtag('config', 'G-XXXXXXXXXX', { send_page_view: true });
</script>
```

### 送信されるカスタムイベント

| イベント | パラメータ |
|---|---|
| `file_loaded` | `count` |
| `preview_play` / `preview_pause` | — |
| `mode_change` | `mode` (`2d`/`sbs`) |
| `convert_start` | `count` |
| `convert_done` | `format`, `ms`, `output_size` |
| `convert_error` | `reason` |
| `parse_error` | `reason` |
| `exif_open` / `exif_edited` | `fields` |

## 技術スタック

- ES Modules、依存ライブラリは `vendor/mp4-muxer.mjs` のみ
- 純 JS で実装した RIFF AVI デマクサ、MPO 分割、ADPCM IMA デコーダ、TIFF/EXIF/MPF パーサ
- WebGL2 シェーダで色補正・回転・3Dモード合成
- WebCodecs + mp4-muxer で MP4 出力
- HTML/CSS のみのレイアウト(フレームワーク不使用)

## 3DS フォーマット概要

### `.AVI` (3DS 3D動画)
- RIFF AVI 1.0、3 ストリーム: MJPEG 左目 + ADPCM IMA 音声 + MJPEG 右目
- 480×240/eye、20fps、ADPCM IMA mono 16kHz
- ストリームタグ: `00dc`(左映像)/ `01wb`(音声)/ `02dc`(右映像)

### `.MPO` (3DS 3D写真)
- CIPA DC-007 MPO: JPEG×2 連結 + 1枚目に MPF (Multi-Picture Format) APP2 マーカー
- 640×480/eye、各 sRGB JPEG
- 3DS固有 MakerNote に Parallax 等
