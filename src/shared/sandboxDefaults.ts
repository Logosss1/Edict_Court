// 命令沙箱 defaults, shared by the main process (settings) and the settings page (「恢复默认」).

/** Package-manager caches commands may keep writing to (relative to the home folder). */
export const DEFAULT_SANDBOX_CACHES = [
  '~/.npm', '~/.cache', '~/Library/Caches', '~/.pnpm-store', '~/Library/pnpm', '~/.yarn', '~/.bun', '~/.deno',
  '~/.cargo/registry', '~/.cargo/git', '~/.rustup/downloads', '~/go/pkg/mod', '~/.gradle', '~/.m2', '~/.ivy2', '~/.sbt',
  '~/.cocoapods', '~/Library/Developer/Xcode/DerivedData', '~/.swiftpm', '~/.nuget', '~/.composer', '~/.gem', '~/.local/share/virtualenvs',
  '~/.node-gyp', '~/.electron-gyp', '~/.android',
];
/** Folders with keys, tokens and browser data that commands may not read. */
export const DEFAULT_SANDBOX_DENY_READ = [
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.config/gh', '~/.config/gcloud', '~/.azure', '~/.kube',
  '~/.pypirc', '~/.git-credentials', '~/Library/Keychains', '~/Library/Cookies', '~/Library/Safari',
  '~/Library/Application Support/Google/Chrome', '~/Library/Application Support/Firefox', '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/BraveSoftware', '~/Library/Application Support/Arc', '~/Library/Messages', '~/Library/Mail',
];
