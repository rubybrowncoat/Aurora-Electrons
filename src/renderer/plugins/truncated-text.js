// Text that ends in an ellipsis keeps its whole value in reach. Under the pointer, an element that can end in an ellipsis takes its full text as a title while the text is cut, and a field whose label is cut gives the label as the title of its slot; where an ancestor has a title of its own, the full text is put in front of it, so that note stays readable. On the keyboard, a control that holds cut text shows the full text in a small popup while it has focus: not while the control's own menu is open (the popup would cover the options), and Escape dismisses it. The text stays whole in the page, so assistive technology reads all of it; the popup is tied to the control by aria-describedby only while it is shown, and not when the control's own name (aria-labelledby, aria-label, its native labels or its text) already holds the whole text. Only the element under the pointer or the focus is watched, whether its text is cut or fits: its text and size are followed, so the title or the popup keeps up with a change under a pointer that does not move or a focus that stays, and is dropped as soon as the text fits.
const MARK = 'data-truncated-title'
const REACH = 8
const GAP = 6
const EDGE = 8
const POPUP = 'truncated-text-tip'
const COMPOSITE = '.v-input, .v-btn, .v-tab, .v-chip, .v-list-item'
// A control whose own menu or list is open: Vuetify's select, autocomplete, combobox and menu activator say so.
const OPEN = '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]'

const normal = (text) => (text || '').replace(/\s+/g, ' ').trim()

// Whether the element can end in an ellipsis, cut or not: an ellipsis on one line, or a line clamp.
const capable = (element) => {
  const { textOverflow, webkitLineClamp } = getComputedStyle(element)

  return textOverflow === 'ellipsis' || webkitLineClamp !== 'none'
}

const isCut = (element) => {
  const { textOverflow, webkitLineClamp } = getComputedStyle(element)

  return (textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) || (webkitLineClamp !== 'none' && element.scrollHeight > element.clientHeight + 1)
}

// A title that is not the one this plugin wrote belongs to the page, which a plugin never overwrites.
const owns = (element) => element.hasAttribute('title') && element.getAttribute('title') !== element.getAttribute(MARK)

// The nearest element from `element` up with a title of the page's, which is the one the browser would show.
const authorOf = (element) => {
  for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
    if (owns(current)) {
      return current
    }
  }

  return null
}

// The element at or above `start` that is cut, else the nearest that could be, and the element whose text it is: the same one, or the label of a field's slot. One that fits is returned too, so it is followed and gets its title when it comes to be cut.
const lookup = (start) => {
  let found = null

  for (let element = start, step = 0; element && element.nodeType === 1 && element !== document.body && step < REACH; step++, element = element.parentElement) {
    const label = element.matches('.v-input__slot') ? element.querySelector('.v-label') : null
    const candidates = [{ host: element, source: element }, ...(label ? [{ host: element, source: label }] : [])].filter(({ source }) => capable(source))
    const cut = candidates.find(({ source }) => isCut(source))

    if (cut) {
      return cut
    }

    found = found || candidates[0] || null
  }

  return found
}

// What the title of `host` is to say: the full text, with a title of an ancestor's after it, or nothing where a title already holds the full text.
const titleFor = (host, source) => {
  const full = normal(source.textContent)
  const author = authorOf(host)

  if (!author) {
    return full
  }

  return author === host || normal(author.getAttribute('title')).includes(full) ? '' : `${full}\n${author.getAttribute('title')}`
}

// Puts `text` on the element as its title, or takes a title of this plugin's off when there is none to show.
const apply = (host, text) => {
  if (owns(host)) {
    return
  }

  if (!text) {
    host.removeAttribute('title')
    host.removeAttribute(MARK)
  } else if (host.getAttribute('title') !== text) {
    host.setAttribute('title', text)
    host.setAttribute(MARK, text)
  }
}

// Calls `run` when the source's text or size, the host's size or the page's title above the host changes; returns what stops it.
const watch = (host, source, run) => {
  const changes = new MutationObserver(run)
  const sizes = new ResizeObserver(run)
  const author = authorOf(host)

  changes.observe(source, { characterData: true, childList: true, subtree: true })

  if (author && author !== host) {
    changes.observe(author, { attributes: true, attributeFilter: ['title'] })
  }

  sizes.observe(source)
  sizes.observe(host)

  return () => {
    changes.disconnect()
    sizes.disconnect()
  }
}

let hover = null

const stopHover = () => {
  if (hover) {
    hover.stop()
    apply(hover.host, '')
    hover = null
  }
}

const overElement = (event) => {
  const found = event.target.nodeType === 1 ? lookup(event.target) : null

  if (hover && found && hover.host === found.host && hover.source === found.source) {
    return
  }

  stopHover()

  if (found) {
    const { host, source } = found
    const refresh = () => apply(host, isCut(source) ? titleFor(host, source) : '')

    refresh()
    hover = { host, source, stop: watch(host, source, refresh) }
  }
}

let keyed = null

// The elements in or under the control that has focus that can end in an ellipsis, cut or not.
const candidatesOf = (root) => [root, ...root.querySelectorAll('*')].filter(capable)

// The name a control has by itself, from the first of these that has any text, in the order of the accessible name: what aria-labelledby points at, aria-label, the native labels (a label for the control, or around it), its own text.
const nameOf = (control) => {
  const labelledby = (control.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ')
  const native = control.labels ? [...control.labels].map((label) => label.textContent).join(' ') : ''

  return normal([labelledby, control.getAttribute('aria-label'), native, control.textContent].find((source) => normal(source)) || '')
}

const place = ({ popup, root }) => {
  const box = root.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  const height = document.documentElement.clientHeight

  popup.style.left = '0px'
  popup.style.top = '0px'

  const size = popup.getBoundingClientRect()
  const below = box.bottom + GAP

  popup.style.left = `${Math.max(EDGE, Math.min(box.left, width - size.width - EDGE))}px`
  popup.style.top = `${below + size.height + EDGE <= height ? below : Math.max(EDGE, box.top - GAP - size.height)}px`
}

// The control's description as the page wrote it.
const restore = ({ control, described }) => {
  if (described === null) {
    control.removeAttribute('aria-describedby')
  } else {
    control.setAttribute('aria-describedby', described)
  }
}

// Takes the popup out of the page, and with it the control's tie to it.
const hide = (state) => {
  state.popup.remove()
  restore(state)
}

const stopFocus = () => {
  if (keyed) {
    keyed.stop()
    hide(keyed)
    keyed = null
  }
}

const focused = (event) => {
  const control = event.target

  stopFocus()

  if (control.nodeType !== 1 || !document.querySelector('.v-application')) {
    return
  }

  const root = control.closest(COMPOSITE) || control
  const popup = document.createElement('div')
  const described = control.getAttribute('aria-describedby')
  const watched = new Set()
  const sizes = new ResizeObserver(() => refresh())
  const refresh = () => {
    const candidates = candidatesOf(root)
    const texts = [...new Set(candidates.filter(isCut).map((element) => normal(element.textContent)))]

    // The geometry of every candidate is followed, so a text that comes to fit or to be cut inside a box of the same size is noticed.
    candidates.filter((element) => !watched.has(element)).forEach((element) => {
      watched.add(element)
      sizes.observe(element)
    })
    watched.forEach((element) => {
      if (!candidates.includes(element)) {
        watched.delete(element)
        sizes.unobserve(element)
      }
    })

    if (texts.length && !keyed.dismissed && !(root.matches(OPEN) || root.querySelector(OPEN))) {
      const name = nameOf(control)

      popup.textContent = texts.join('\n')
      document.querySelector('.v-application').appendChild(popup)
      place(keyed)

      if (texts.every((text) => name.includes(text))) {
        restore(keyed)
      } else {
        control.setAttribute('aria-describedby', described ? `${described} ${popup.id}` : popup.id)
      }
    } else {
      hide(keyed)
    }
  }
  const changes = new MutationObserver(refresh)
  const reposition = () => keyed && popup.isConnected && place(keyed)

  popup.className = POPUP
  popup.id = `${POPUP}-${Date.now()}`
  popup.setAttribute('role', 'tooltip')
  changes.observe(root, { characterData: true, childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
  keyed = {
    control,
    root,
    popup,
    described,
    dismissed: false,
    stop: () => {
      changes.disconnect()
      sizes.disconnect()
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    },
  }
  refresh()
}

document.addEventListener('mouseover', overElement, { passive: true })
document.addEventListener('mouseout', (event) => !event.relatedTarget && stopHover(), { passive: true })
document.addEventListener('focusin', focused, { passive: true })
document.addEventListener('focusout', stopFocus, { passive: true })
// In the capture phase, before the page's own handlers: an Escape that closes the field's menu must find the popup as it was when the key went down (not shown), however soon the page updates the field.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && keyed && keyed.popup.isConnected) {
    keyed.dismissed = true
    hide(keyed)
  }
}, { capture: true, passive: true })
