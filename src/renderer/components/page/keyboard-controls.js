// Vuetify 2 leaves two kinds of control to the pointer. A sortable column head of the desktop data table gets a click handler and nothing else (VDataTableHeaderDesktop sets no tabindex and no key handler), and a chip that is clickable or sits in a chip group is a `span` with no key handler (a group's chip gets tabindex 0 but Enter and Space do nothing; a chip with a click listener outside a group gets no tabindex). This global mixin wraps one method of each component, per instance: a sortable head joins the tab order and Enter or Space sorts it as a click does, and a clickable chip is focusable and Enter or Space activates it as a click does (a filter chip toggles). Header attributes (`aria-sort`, `aria-label`) and a chip's own markup stay as Vuetify wrote them, a key pressed on something inside the control (a chip's close button) is left alone, and a chip that is a link is left to the browser. The focus ring is drawn by styles/appearance.scss.
const HEADER = 'v-data-table-header-desktop'
const CHIP = 'v-chip'

const isActivation = (event) => event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')

const wrapHeader = (vm) => {
  const genHeader = vm.genHeader

  vm.genHeader = (header) => {
    const th = genHeader(header)
    const data = th && th.data

    if (!data || !data.on || !data.on.click || !data.class || !data.class.includes('sortable')) return th

    data.attrs.tabindex = 0
    data.on.keydown = (event) => {
      if (!isActivation(event)) return

      event.preventDefault()
      vm.$emit('sort', header.value)
    }

    return th
  }
}

const wrapChip = (vm) => {
  const generateRouteLink = vm.generateRouteLink

  vm.generateRouteLink = () => {
    const link = generateRouteLink()
    const { data } = link

    if (vm.disabled || vm.isLink || !vm.isClickable || !data.on) return link

    data.attrs.tabindex = 0
    data.on.keydown = (event) => {
      if (!isActivation(event)) return

      event.preventDefault()
      vm.click(event)
    }

    return link
  }
}

export const keyboardControls = {
  created () {
    if (this.$options.name === HEADER) wrapHeader(this)
    else if (this.$options.name === CHIP) wrapChip(this)
  },
}
