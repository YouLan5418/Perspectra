import type { FaultPoint } from '@harness-world/contracts'
import { DeploymentBackupService } from '@harness-world/operations'
import { IpcPauseFaultInjector } from '@harness-world/testkit'

const [mode, worldPath, sessionPath, memoryPath, contextPath, lockPath, artifactPath, targetPath, faultPoint]
  = process.argv.slice(2)
if ((mode !== 'backup' && mode !== 'restore')
  || worldPath === undefined || sessionPath === undefined || memoryPath === undefined
  || contextPath === undefined || lockPath === undefined || artifactPath === undefined
  || targetPath === undefined || faultPoint === undefined) {
  throw new Error('usage: deployment-backup-crash-worker <backup|restore> <world> <session> <memory> <context> <lock> <artifact> <target> <fault-point>')
}

const service = new DeploymentBackupService({ worldPath, sessionPath, memoryPath, contextPath, lockPath }, Date.now,
  new IpcPauseFaultInjector(faultPoint as FaultPoint))

if (mode === 'backup') {
  await service.backup(targetPath, 'crash:deployment-backup')
} else {
  service.restore(artifactPath, targetPath, 'crash:deployment-restore')
}
