// Well-known language servers (data only). Order matters: when several servers handle the same
// extension, the first one that is enabled and installed wins.

export interface LspCommandCandidate {
  /** Executable looked up on PATH + common install dirs (or an absolute path). */
  cmd: string;
  args: string[];
  /** macOS: also try `xcrun --find <cmd>` (toolchain binaries shipped with Xcode / Command Line Tools). */
  xcrun?: boolean;
  /** How to read the version: args for the same binary, or a sibling executable in the same dir. Omitted = do not probe. */
  version?: { args: string[]; sibling?: string };
}

/** Chinese install hints; `all` is the fallback for platforms without a specific entry. */
export interface LspInstallHints {
  darwin?: string;
  linux?: string;
  win32?: string;
  all?: string;
}

export interface LspServerDef {
  id: string;
  name: string;
  /** Human language names, for UI and messages. */
  languages: string[];
  /** LSP languageId values this server handles. */
  languageIds: string[];
  /** Lowercase, with the dot. */
  extensions: string[];
  /** Exact basenames without a useful extension (Gemfile, .bashrc …). */
  filenames?: string[];
  commands: LspCommandCandidate[];
  /** Files that mark a project root for this server (`*.ext` = any file with that extension). */
  rootMarkers: string[];
  install: LspInstallHints;
  homepage: string;
  initializationOptions?: Record<string, unknown>;
  /** Fill initializationOptions.typescript.tsdk from <root>/node_modules/typescript/lib when present. */
  tsdk?: boolean;
  /** Values for workspace/configuration (dotted section → value); unlisted sections get null. */
  settings?: Record<string, unknown>;
}

/** LSP languageId by extension (didOpen needs one). */
export const LANGUAGE_ID_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.ipp': 'cpp', '.inl': 'cpp', '.m': 'objective-c', '.mm': 'objective-cpp',
  '.swift': 'swift',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby', '.ru': 'ruby',
  '.php': 'php', '.phtml': 'php',
  '.lua': 'lua',
  '.sh': 'shellscript', '.bash': 'shellscript', '.command': 'shellscript',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.dart': 'dart',
  '.cs': 'csharp', '.csx': 'csharp',
  '.zig': 'zig', '.zon': 'zig',
  '.vue': 'vue',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.json': 'json', '.jsonc': 'jsonc',
};

export const LANGUAGE_ID_BY_FILENAME: Record<string, string> = {
  Gemfile: 'ruby', Rakefile: 'ruby', Podfile: 'ruby', Fastfile: 'ruby',
  '.bashrc': 'shellscript', '.bash_profile': 'shellscript', '.profile': 'shellscript',
};

const NPM_HTML = 'npm i -g vscode-langservers-extracted';

export const LSP_SERVERS: LspServerDef[] = [
  {
    id: 'typescript-language-server', name: 'TypeScript Language Server', languages: ['TypeScript', 'JavaScript'],
    languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    commands: [{ cmd: 'typescript-language-server', args: ['--stdio'], version: { args: ['--version'] } }],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: { all: 'npm i -g typescript-language-server typescript' },
    homepage: 'https://github.com/typescript-language-server/typescript-language-server',
  },
  {
    id: 'vtsls', name: 'vtsls', languages: ['TypeScript', 'JavaScript'],
    languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    commands: [{ cmd: 'vtsls', args: ['--stdio'], version: { args: ['--version'] } }],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: { all: 'npm i -g @vtsls/language-server' },
    homepage: 'https://github.com/yioneko/vtsls',
  },
  {
    id: 'pyright', name: 'Pyright', languages: ['Python'], languageIds: ['python'], extensions: ['.py', '.pyi'],
    commands: [{ cmd: 'pyright-langserver', args: ['--stdio'], version: { args: ['--version'], sibling: 'pyright' } }],
    rootMarkers: ['pyrightconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    install: { darwin: 'brew install pyright（或 npm i -g pyright / pipx install pyright）', all: 'npm i -g pyright（或 pipx install pyright / pip install pyright）' },
    homepage: 'https://github.com/microsoft/pyright',
  },
  {
    id: 'basedpyright', name: 'basedpyright', languages: ['Python'], languageIds: ['python'], extensions: ['.py', '.pyi'],
    commands: [{ cmd: 'basedpyright-langserver', args: ['--stdio'], version: { args: ['--version'], sibling: 'basedpyright' } }],
    rootMarkers: ['pyrightconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    install: { all: 'pipx install basedpyright（或 uv tool install basedpyright / pip install basedpyright）' },
    homepage: 'https://docs.basedpyright.com',
  },
  {
    id: 'pylsp', name: 'python-lsp-server (pylsp)', languages: ['Python'], languageIds: ['python'], extensions: ['.py', '.pyi'],
    commands: [{ cmd: 'pylsp', args: [], version: { args: ['--version'] } }],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    install: { all: 'pipx install "python-lsp-server[all]"（或 pip install "python-lsp-server[all]"）' },
    homepage: 'https://github.com/python-lsp/python-lsp-server',
  },
  {
    id: 'gopls', name: 'gopls', languages: ['Go'], languageIds: ['go'], extensions: ['.go'],
    commands: [{ cmd: 'gopls', args: [], version: { args: ['version'] } }],
    rootMarkers: ['go.work', 'go.mod'],
    install: { darwin: 'brew install gopls（或 go install golang.org/x/tools/gopls@latest）', all: 'go install golang.org/x/tools/gopls@latest（安装到 ~/go/bin）' },
    homepage: 'https://go.dev/gopls',
  },
  {
    id: 'rust-analyzer', name: 'rust-analyzer', languages: ['Rust'], languageIds: ['rust'], extensions: ['.rs'],
    commands: [{ cmd: 'rust-analyzer', args: [], version: { args: ['--version'] } }],
    rootMarkers: ['Cargo.toml', 'rust-project.json'],
    install: { darwin: 'rustup component add rust-analyzer（或 brew install rust-analyzer）', all: 'rustup component add rust-analyzer' },
    homepage: 'https://rust-analyzer.github.io',
  },
  {
    id: 'clangd', name: 'clangd', languages: ['C', 'C++', 'Objective-C'], languageIds: ['c', 'cpp', 'objective-c', 'objective-cpp'],
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.ipp', '.inl', '.m', '.mm'],
    commands: [{ cmd: 'clangd', args: [], xcrun: true, version: { args: ['--version'] } }],
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', 'meson.build', 'Makefile'],
    install: { darwin: 'xcode-select --install（Xcode 命令行工具自带 clangd），或 brew install llvm', linux: 'sudo apt install clangd（或使用发行版对应的 clangd 包）', all: '安装 LLVM（自带 clangd）' },
    homepage: 'https://clangd.llvm.org',
  },
  {
    id: 'sourcekit-lsp', name: 'SourceKit-LSP', languages: ['Swift'], languageIds: ['swift'], extensions: ['.swift'],
    commands: [{ cmd: 'sourcekit-lsp', args: [], xcrun: true }],
    rootMarkers: ['Package.swift', '*.xcodeproj', '*.xcworkspace'],
    install: { darwin: 'xcode-select --install（随 Xcode / 命令行工具提供，可用 xcrun --find sourcekit-lsp 验证）', all: '安装 swift.org 官方 Swift 工具链（自带 sourcekit-lsp）' },
    homepage: 'https://github.com/swiftlang/sourcekit-lsp',
  },
  {
    id: 'jdtls', name: 'Eclipse JDT Language Server', languages: ['Java'], languageIds: ['java'], extensions: ['.java'],
    commands: [{ cmd: 'jdtls', args: [] }],
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', '.project'],
    install: { darwin: 'brew install jdtls（需 JDK 17+）', all: '从 download.eclipse.org/jdtls 下载并把 bin/jdtls 加入 PATH（需 JDK 17+）' },
    homepage: 'https://github.com/eclipse-jdtls/eclipse.jdt.ls',
  },
  {
    id: 'kotlin-language-server', name: 'Kotlin Language Server', languages: ['Kotlin'], languageIds: ['kotlin'], extensions: ['.kt', '.kts'],
    commands: [{ cmd: 'kotlin-language-server', args: [] }],
    rootMarkers: ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle', 'pom.xml'],
    install: { darwin: 'brew install kotlin-language-server', all: '从 GitHub Releases 下载 server.zip，并把其中 bin 目录加入 PATH' },
    homepage: 'https://github.com/fwcd/kotlin-language-server',
  },
  {
    id: 'ruby-lsp', name: 'Ruby LSP', languages: ['Ruby'], languageIds: ['ruby'], extensions: ['.rb', '.rake', '.gemspec', '.ru'], filenames: ['Gemfile', 'Rakefile', 'Podfile', 'Fastfile'],
    commands: [{ cmd: 'ruby-lsp', args: [], version: { args: ['--version'] } }],
    rootMarkers: ['Gemfile', '.ruby-version'],
    install: { all: 'gem install ruby-lsp' },
    homepage: 'https://github.com/Shopify/ruby-lsp',
  },
  {
    id: 'solargraph', name: 'Solargraph', languages: ['Ruby'], languageIds: ['ruby'], extensions: ['.rb', '.rake', '.gemspec', '.ru'], filenames: ['Gemfile', 'Rakefile', 'Podfile', 'Fastfile'],
    commands: [{ cmd: 'solargraph', args: ['stdio'], version: { args: ['--version'] } }],
    rootMarkers: ['Gemfile', '.solargraph.yml'],
    install: { all: 'gem install solargraph' },
    homepage: 'https://solargraph.org',
  },
  {
    id: 'intelephense', name: 'Intelephense', languages: ['PHP'], languageIds: ['php'], extensions: ['.php', '.phtml'],
    commands: [{ cmd: 'intelephense', args: ['--stdio'] }],
    rootMarkers: ['composer.json'],
    install: { all: 'npm i -g intelephense' },
    homepage: 'https://intelephense.com',
  },
  {
    id: 'lua-language-server', name: 'Lua Language Server', languages: ['Lua'], languageIds: ['lua'], extensions: ['.lua'],
    commands: [{ cmd: 'lua-language-server', args: [], version: { args: ['--version'] } }],
    rootMarkers: ['.luarc.json', '.luarc.jsonc', '.stylua.toml'],
    install: { darwin: 'brew install lua-language-server', all: '从 GitHub Releases 下载 lua-language-server 并加入 PATH（部分发行版可用包管理器安装）' },
    homepage: 'https://luals.github.io',
  },
  {
    id: 'bash-language-server', name: 'Bash Language Server', languages: ['Bash'], languageIds: ['shellscript'], extensions: ['.sh', '.bash', '.command'], filenames: ['.bashrc', '.bash_profile', '.profile'],
    commands: [{ cmd: 'bash-language-server', args: ['start'], version: { args: ['--version'] } }],
    rootMarkers: [],
    install: { darwin: 'brew install bash-language-server（或 npm i -g bash-language-server）', all: 'npm i -g bash-language-server' },
    homepage: 'https://github.com/bash-lsp/bash-language-server',
  },
  {
    id: 'yaml-language-server', name: 'YAML Language Server', languages: ['YAML'], languageIds: ['yaml'], extensions: ['.yaml', '.yml'],
    commands: [{ cmd: 'yaml-language-server', args: ['--stdio'] }],
    rootMarkers: [],
    install: { darwin: 'brew install yaml-language-server（或 npm i -g yaml-language-server）', all: 'npm i -g yaml-language-server' },
    homepage: 'https://github.com/redhat-developer/yaml-language-server',
  },
  {
    id: 'dart', name: 'Dart Analysis Server', languages: ['Dart'], languageIds: ['dart'], extensions: ['.dart'],
    commands: [{ cmd: 'dart', args: ['language-server', '--protocol=lsp'], version: { args: ['--version'] } }],
    rootMarkers: ['pubspec.yaml'],
    install: { darwin: 'brew tap dart-lang/dart && brew install dart（或安装 Flutter SDK）', all: '安装 Dart SDK（dart.dev/get-dart）或 Flutter SDK' },
    homepage: 'https://dart.dev/tools/dart-tool',
  },
  {
    id: 'csharp-ls', name: 'csharp-ls', languages: ['C#'], languageIds: ['csharp'], extensions: ['.cs', '.csx'],
    commands: [{ cmd: 'csharp-ls', args: [], version: { args: ['--version'] } }],
    rootMarkers: ['*.sln', '*.csproj'],
    install: { all: 'dotnet tool install --global csharp-ls（需 .NET SDK，安装到 ~/.dotnet/tools）' },
    homepage: 'https://github.com/razzmatazz/csharp-language-server',
  },
  {
    id: 'zls', name: 'ZLS', languages: ['Zig'], languageIds: ['zig'], extensions: ['.zig', '.zon'],
    commands: [{ cmd: 'zls', args: [], version: { args: ['--version'] } }],
    rootMarkers: ['build.zig', 'build.zig.zon'],
    install: { darwin: 'brew install zls', all: '从 GitHub Releases 下载与 Zig 版本匹配的 zls 并加入 PATH' },
    homepage: 'https://github.com/zigtools/zls',
  },
  {
    // Vue LS ≥ 3 delegates TS features to a tsserver plugin; standalone it still serves template diagnostics/symbols.
    id: 'vue-language-server', name: 'Vue Language Server', languages: ['Vue'], languageIds: ['vue'], extensions: ['.vue'],
    commands: [{ cmd: 'vue-language-server', args: ['--stdio'], version: { args: ['--version'] } }],
    rootMarkers: ['package.json'],
    install: { all: 'npm i -g @vue/language-server' },
    homepage: 'https://github.com/vuejs/language-tools',
    initializationOptions: { vue: { hybridMode: false } },
    tsdk: true,
  },
  {
    id: 'vscode-html-language-server', name: 'HTML Language Server', languages: ['HTML'], languageIds: ['html'], extensions: ['.html', '.htm'],
    commands: [{ cmd: 'vscode-html-language-server', args: ['--stdio'] }],
    rootMarkers: [],
    install: { all: NPM_HTML },
    homepage: 'https://github.com/hrsh7th/vscode-langservers-extracted',
    initializationOptions: { provideFormatter: false, embeddedLanguages: { css: true, javascript: true } },
  },
  {
    id: 'vscode-css-language-server', name: 'CSS Language Server', languages: ['CSS', 'SCSS', 'Less'], languageIds: ['css', 'scss', 'less'], extensions: ['.css', '.scss', '.less'],
    commands: [{ cmd: 'vscode-css-language-server', args: ['--stdio'] }],
    rootMarkers: [],
    install: { all: NPM_HTML },
    homepage: 'https://github.com/hrsh7th/vscode-langservers-extracted',
    initializationOptions: { provideFormatter: false },
    settings: { css: { validate: true }, scss: { validate: true }, less: { validate: true } },
  },
  {
    id: 'vscode-json-language-server', name: 'JSON Language Server', languages: ['JSON'], languageIds: ['json', 'jsonc'], extensions: ['.json', '.jsonc'],
    commands: [{ cmd: 'vscode-json-language-server', args: ['--stdio'] }],
    rootMarkers: [],
    install: { all: NPM_HTML },
    homepage: 'https://github.com/hrsh7th/vscode-langservers-extracted',
    initializationOptions: { provideFormatter: false },
    settings: { json: { validate: { enable: true } } },
  },
];
