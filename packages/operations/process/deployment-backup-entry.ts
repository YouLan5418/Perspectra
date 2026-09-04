import { canonicalizeWorldJson, WorldError, type WorldJsonValue } from '@harness-world/contracts'
import {
  DeploymentBackupService,
  ensureWorldHostLayout,
  resolveWorldHostConfig,
} from '../src/index.ts'

const argv = process.argv.slice(2)
const [operation, firstPath] = argv
if (operation === undefined || firstPath === undefined) {
  throw new TypeError('usage: worlddeploy <create|validate|restore> <artifact-directory> [target-directory] [host config options]')
}
const secondPath = operation === 'restore' ? argv[2] : undefined
const config = resolveWorldHostConfig(argv.slice(operation === 'restore' ? 3 : 2))
if (operation === 'create') ensureWorldHostLayout(config)
const service = new DeploymentBackupService({
  worldPath: config.worldPath,
  auditPath: `${config.worldPath}.audit.sqlite`,
  sessionPath: config.sessionPath,
  memoryPath: config.memoryPath,
  contextPath: config.contextPath,
  lockPath: config.lockPath,
})

try {
  let result: WorldJsonValue
  if (operation === 'create') {
    result = await service.backup(firstPath, 'worlddeploy:create')
  } else if (operation === 'validate') {
    result = service.validate(firstPath, 'worlddeploy:validate')
  } else if (operation === 'restore') {
    if (secondPath === undefined) throw new TypeError('worlddeploy restore requires a new target directory')
    result = service.restore(firstPath, secondPath, 'worlddeploy:restore')
  } else {
    throw new TypeError(`unknown worlddeploy operation ${operation}`)
  }
  process.stdout.write(`${Buffer.from(canonicalizeWorldJson(result)).toString('utf8')}\n`)
} catch (error: unknown) {
  if (error instanceof WorldError) {
    process.stdout.write(`${Buffer.from(canonicalizeWorldJson(error.envelope as unknown as WorldJsonValue)).toString('utf8')}\n`)
    process.exitCode = 1
  } else {
    throw error
  }
}
