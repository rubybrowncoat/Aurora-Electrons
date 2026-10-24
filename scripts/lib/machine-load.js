// Says how busy the machine was while a check timed its work, so that a run that failed a time budget beside another heavy job is not mistaken for a regression of the code. The condition is only reported: no check passes, fails, skips or relaxes on it.
// The shares come from the processor times the operating system keeps for every logical processor (the same on Windows, Linux and macOS, nothing to start) and from the CPU time of this process alone, so the rest is the share of every other process on the machine, those of another lane's supervised run included.
const os = require('os')

// The CPU time of every logical processor in milliseconds from the list `os.cpus()` gives, as { busy, total } (`total` with the idle time). Windows reports its `sys` as kernel time less idle time, which holds the interrupt time `irq` repeats, so there `irq` is left out; elsewhere `irq` is a time of its own.
const processorTimes = (cpus, platform = process.platform) => cpus.reduce((sums, { times }) => {
  const busy = times.user + times.nice + times.sys + (platform === 'win32' ? 0 : times.irq)

  return { busy: sums.busy + busy, total: sums.total + busy + times.idle }
}, { busy: 0, total: 0 })

// What has been spent so far: `busy` and `total` as `processorTimes` gives them, `own` the CPU time of this process.
const snapshot = () => {
  const cpus = os.cpus()
  const { user, system } = process.cpuUsage()

  return { at: performance.now(), processors: cpus.length, ...processorTimes(cpus), own: (user + system) / 1000 }
}

// The shares in percent of all the processors' time between two snapshots: `machine` is the busy share of every process, `own` this process's, `others` the difference (never below 0, as the two clocks tick apart). Null when no processor time passed between them, as when the system's clock has not ticked.
const loadShare = (from, to) => {
  const passed = to.total - from.total

  if (!(passed > 0)) {
    return null
  }

  const machine = Math.min(100, Math.max(0, ((to.busy - from.busy) / passed) * 100))
  const own = Math.min(machine, Math.max(0, ((to.own - from.own) / passed) * 100))

  return { seconds: (to.at - from.at) / 1000, processors: to.processors, machine, own, others: machine - own }
}

const describeLoad = (share) => (share ? `machine ${share.machine.toFixed(0)}% busy over ${share.seconds.toFixed(1)} s on ${share.processors} logical processors, this check ${share.own.toFixed(0)}% and every other process ${share.others.toFixed(0)}%` : 'machine load not readable (no processor time passed)')

// Starts a window now: `read()` gives { share, text } for the time since, as many times as wanted.
const watchLoad = () => {
  const from = snapshot()

  return {
    read: () => {
      const share = loadShare(from, snapshot())

      return { share, text: describeLoad(share) }
    },
  }
}

module.exports = { processorTimes, snapshot, loadShare, describeLoad, watchLoad }
