import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const packageJson = fileURLToPath(new URL('../package.json', import.meta.url))
const packageRoot = dirname(packageJson)
const entry = createRequire(packageJson).resolve('@harness-world/plugin-sdk')
const tsconfig = ts.getParsedCommandLineOfConfigFile(
  resolve(packageRoot, 'tsconfig.contract-test.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  },
)
if (tsconfig === undefined) throw new Error('contract typecheck config was not read')

const program = ts.createProgram({ rootNames: [entry], options: tsconfig.options })
const diagnostics = ts.getPreEmitDiagnostics(program)
expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])

const specifiers = new Set<string>()
const packagesRoot = resolve(packageRoot, '..')
const resolvedImplementationSources = new Set<string>()
for (const source of program.getSourceFiles()) {
  const file = resolve(source.fileName)
  if (!file.startsWith(packagesRoot)) continue
  if (!file.startsWith(packageRoot) && !file.startsWith(resolve(packagesRoot, 'contracts'))) {
    resolvedImplementationSources.add(relative(packagesRoot, file).replaceAll('\\', '/'))
  }
  if (!file.startsWith(packageRoot)) continue
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.add(statement.moduleSpecifier.text)
    }
  }
}

it('loads the SDK public source closure without implementation packages', () => {
  expect(entry.replaceAll('\\', '/')).toMatch(/\/packages\/plugin-sdk\/src\/index\.ts$/u)
  expect([...resolvedImplementationSources]).toEqual([])
  const forbidden =
    /^@harness-world\/(?:application|frontend|kernel|memory|official(?:-[^/]+)?|provider-chat|runtime-cordis|store-sqlite)(?:\/|$)/u
  expect([...specifiers].filter(specifier => forbidden.test(specifier))).toEqual([])
})
