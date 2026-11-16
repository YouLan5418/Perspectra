import { Server } from 'node:net'
import { BLOCKED_PORTS } from '../../apps/host/src/safe-port.ts'
import { avoidBlockedPorts } from './avoid-blocked-ports.ts'

avoidBlockedPorts(Server.prototype, port => BLOCKED_PORTS.has(port))
