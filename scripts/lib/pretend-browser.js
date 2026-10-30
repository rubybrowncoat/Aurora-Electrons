// A browser that is only enough of one for the opening of an observation (`observe` of scripts/lib/browser-observe.js), for a control of a page check: every call of its page resolves at once (a load, a click, a wait, the wait of `settled` for the reads of the page, which it answers as done), the race is picked and nothing loads, and a `page.evaluate` whose function pushes a route of the app's router throws NAVIGATION_FAILED, as a navigation that does not end. The control reads the step the observation names for it: a step said after the call it names would name the step before, and so would the deadline of the runner (scripts/lib/suite-runner.js) for a navigation that hangs.
//
// const { pretendBrowser, NAVIGATION_FAILED } = require('./lib/pretend-browser')
// const seen = await observePage(pretendBrowser(), 'http://pretend.test/')   // seen.error === NAVIGATION_FAILED, seen.phase the step of the navigation
const NAVIGATION_FAILED = 'the navigation of the pretend page failed'

const pretendBrowser = () => {
  const picker = { locator: () => picker, filter: () => picker, first: () => picker, last: () => picker, getByText: () => picker, click: async () => {} }
  const page = {
    on: () => {},
    addInitScript: async () => {},
    goto: async () => null,
    locator: () => picker,
    waitForFunction: async () => true,
    waitForSelector: async () => null,
    waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    evaluate: async (work) => {
      const text = String(work)

      if (text.includes('$router.push')) {
        throw new Error(NAVIGATION_FAILED)
      }

      if (text.includes('__auroraReads')) {
        return { signal: true, settled: true, pending: [] }
      }

      return text.includes('RaceID')
    },
  }

  return { newContext: async () => ({ newPage: async () => page, close: async () => {} }) }
}

module.exports = { pretendBrowser, NAVIGATION_FAILED }
