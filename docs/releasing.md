# リリース運用

## 承認と公開

`main` への push で `.github/workflows/release.yml` が release-please を実行する。
リリース対象の Conventional Commit があれば Release PR を作成・更新する。
通常の変更のマージでは npm に公開しない。

Release PR は `package.json`、`package-lock.json`、`.release-please-manifest.json`、`CHANGELOG.md` を更新する。
メンテナーは差分とバージョンを確認してマージする。このマージが公開の承認になる。
続く同じワークフロー内でタグと GitHub Release を作成し、そのタグを checkout して npm に公開する。
タグとパッケージ・ロックファイルのバージョンが一致しない場合、依存インストール・型チェック・テストが失敗した場合、npm レジストリの照会に失敗した場合は公開しない。

`GITHUB_TOKEN` が作ったタグや Release を別のワークフローのトリガーとして使わない。
Release 作成ジョブの `release_created` 出力が `true` の場合だけ公開ジョブを実行する。
手動実行は既存 Release の公開失敗を復旧するためだけに使用する。

## 初期化とバージョン規則

導入時点で npm の最新バージョンと両パッケージファイルは `0.2.0`。
npm の `gitHead` は `6920f602aa1b7971135bc4aa712c72f193075707`。
GitHub とリモートの既存タグ・Release は `v0.1.1` だけで、`v0.2.0` はない。

そのため manifest に `0.2.0` を設定し、`bootstrap-sha` をこの公開済みコミットに設定する。
初回の履歴取り込みはこの SHA より後だけで、すでに `0.2.0` に含まれる変更を次の CHANGELOG に再掲載しない。
初回 Release PR のマージ後は manifest のバージョンに対応する Release が境界となり、
`bootstrap-sha` は使われなくなる（削除してよい）。
`last-release-sha` や `release-as` による恒久的な上書きは設定しない。
過去の CHANGELOG は手作業で捏造せず、最初の Release PR が新規作成する。

| コミット例 | `0.2.0` からの次バージョン |
| --- | --- |
| `fix: 不具合を修正` | `0.2.1` |
| `feat: 機能を追加` | `0.3.0` |
| `feat!: 互換性を変更` または本文に `BREAKING CHANGE:` | `1.0.0` |
| `chore:`、`docs:` だけ | Release PR を作らない |

両 pre-major オプションは `false`。導入だけでは `1.0.0` にしない。
PR を squash merge する場合、PR タイトルと最終的なコミット本文に Conventional Commit と破壊的変更情報を残す。

## メンテナーが行う初回設定

### GitHub

1. リポジトリ `wh3at/pi-command-queue` の Settings → Actions → General で Actions と使用するアクションを許可する。
2. Workflow permissions の **Allow GitHub Actions to create and approve pull requests** を有効にする。組織ポリシーで禁止されている場合は管理者に依頼する。
3. ワークフローはジョブ単位で Release 作成に `contents: write` と `pull-requests: write`、
   公開に `contents: read` と `id-token: write` を要求する。公開ジョブに書き込み用 GitHub トークンは渡さない。
4. ブランチ保護ルールと Release PR のマージ権限を確認する。
   `GITHUB_TOKEN` で作成・更新した PR は通常の PR 用 CI を起動しないため、
   必須チェックがある場合は運用を確認する。この構成は公開直前に検証する。
   PR 用 CI も自動起動させる必要がある場合の GitHub App/PAT 導入は別途検討する。
5. この変更を `main` にマージする。npm の公開トークンを GitHub Secrets に登録する必要はない。

### npm

パッケージを管理できるメンテナーが npmjs.com の `pi-command-queue` → Settings → Trusted Publisher で GitHub Actions を選ぶ。

| フィールド | 値 |
| --- | --- |
| Organization or user | `wh3at` |
| Repository | `pi-command-queue` |
| Workflow filename | `release.yml`（パスではなくファイル名のみ） |
| Environment name | 空欄（ワークフローは environment を使わない） |
| Allowed actions（表示される場合） | 直接公開の `npm publish` を許可 |

GitHub-hosted の `ubuntu-latest` を使う。self-hosted runner は対象外。
公式要件は Node >= 22.14.0、npm >= 11.5.1。このワークフローは Node 24 と npm 11.19.1 を使う。
OIDC には `id-token: write` が必要で、`NODE_AUTH_TOKEN` / `NPM_TOKEN` は設定しない。
公開リポジトリからの Trusted Publishing は provenance を自動生成する。
`package.json` の repository はこの GitHub リポジトリと一致させる。

公式ドキュメントで初回公開までの有効期限（現在は設定後2日）を確認し、
次の実リリースに合わせて設定する。失効した場合は削除・再作成する。
初回成功後は Publishing access の **Require two-factor authentication and disallow tokens** を推奨する。

### 初回の実リリース確認

1. 正当な `fix:` または `feat:` を `main` に取り込み、Release PR が作られることを確認する。
   検証だけを目的にダミーの公開や破壊的コミットを作らない。
2. PR 内のパッケージ・ロック・manifest のバージョンが一致し、CHANGELOG が初期化境界より後の変更だけを含むことを確認する。
3. npm の Trusted Publisher 設定完了後、Release PR をマージする。
4. Actions の Release 実行で Release 作成、タグの checkout、型チェック、テスト、OIDC 公開が成功したことを確認する。
5. `gh release view v<VERSION> --repo wh3at/pi-command-queue` と
   `npm view pi-command-queue@<VERSION> version dist.integrity dist.attestations --json` でバージョン・provenance を確認する。
   npmjs.com の provenance リンクがこのリポジトリと実行を指すことを確認する。
6. `pi install npm:pi-command-queue@<VERSION>` でインストールを確認する。

## 公開失敗時の復旧

GitHub Release は npm 公開より先に作成される。公開失敗でもタグや Release を削除しない。
ログで依存インストール・型チェック・テスト・npm のどの段階が失敗したかを確認する。
OIDC エラーなら npm 側のリポジトリ・ファイル名・環境名・直接公開許可・設定期限と
ジョブの `id-token: write` を確認する。レジストリの 404 以外のエラーは未公開として扱わない。

公開ジョブだけが失敗した場合は **Re-run failed jobs** を使える。
全ジョブの再実行では Release 作成出力が失われ、公開ジョブがスキップされる場合がある。
その場合やワークフロー自体を修正した場合は `main` 上の **Run workflow** を使う：

```sh
gh workflow run release.yml --repo wh3at/pi-command-queue --ref main -f tag=v<VERSION>
```

手動実行は安定版の既存 GitHub Release が必須で、任意の SHA やブランチは指定できない。
公開対象は常に指定タグのコードであり、復旧時の `main` のコードではない。
タグとパッケージ・ロックファイルのバージョン整合、依存インストール、型チェック、テストをもう一度実行する。
タグのコードそのものに不具合があるならタグを書き換えず、修正を取り込んで新しい Release PR で公開する。

npm に同じバージョンが存在すれば公開をスキップする。公開成功後に Actions の応答だけが失敗した場合も再公開しない。
同一ワークフローの公開処理は concurrency で直列化する。
npm に同じバージョンがあるのに内容が違うと疑われる場合は provenance と整合性を調査し、新しいバージョンで修正する。

## 検証の範囲

ローカルで確認できるもの：設定スキーマ、ワークフロー構文、release-please のバージョン計算と更新内容、
既存テスト、型チェック、公開パッケージの内容。
ローカルだけでは確認できないもの：GitHub 上の Release PR 作成・マージ・タグ作成、
npm 側の許可設定、OIDC 認証、実公開、公開後のインストール。
後者はメンテナーの初回設定・実リリースで確認するまで未検証として扱う。

### 導入時のローカル検証結果

- Node 24.18.0：`npm run typecheck` 成功、`npm test` 全26件成功。
- actionlint 1.7.12：`release.yml` の構文・アクション入力の検証成功。
- release-please 17.11.2：設定と manifest のスキーマ検証成功。実際の Node strategy にコミット例を渡し、上記のバージョン表、package・lock の整合した更新、CHANGELOG 生成を確認。
- ワークフロー内のコマンドを隔離ディレクトリで実行：タグ・lock の不一致で失敗、公開済み `0.2.0` をスキップ、HTTP 404 のみ公開可能、403/500 では失敗することを確認。公開コマンドは実行していない。
- `npm pack --dry-run`：既存の配布ファイルのみ（LICENSE、README、package.json、3つのソースファイル）。
- GitHub の現在の `can_approve_pull_request_reviews` は `false`。上記の PR 作成許可設定はメンテナーの残作業。
- `npm ci` の監査は既存の間接依存 `brace-expansion` に high 1件を報告。依存更新は本変更の対象外。

## 公式資料

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [release-please manifest と初期化](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [release-please-action と権限・出力](https://github.com/googleapis/release-please-action)
