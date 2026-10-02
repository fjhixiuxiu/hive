/**
 * Mobile keys popover — keeps the session keys bar resting on the status line
 * that holds its ⌨ Keys toggle.
 *
 * On phones the keys bar is a fixed popover. It used to sit a hardcoded 80px
 * above the bottom of the screen, which is the height of the status line plus a
 * one-row composer. The composer grows as you type (the first keystroke alone
 * takes it from 36px to its four-row height), the status line moves up with it,
 * and the popover then covered the toggle — the only control that closed it. A
 * tap on the toggle landed on a key button and sent that key instead.
 *
 * So the popover is placed from where the status line actually is, re-placed
 * whenever anything below it changes size, and a tap anywhere outside it closes
 * it as well.
 */
(function (root) {
  'use strict';

  /**
   * CSS `bottom` for a fixed popover whose bottom edge should meet the anchor's
   * top edge.
   * @param {number} viewportHeight - the layout viewport's height
   * @param {number} anchorTop - the anchor's top, from getBoundingClientRect
   * @returns {number}
   */
  function popoverBottom(viewportHeight, anchorTop) {
    return Math.max(0, Math.round(viewportHeight - anchorTop));
  }

  /**
   * @param {{
   *   keysBar: HTMLElement,
   *   anchor: HTMLElement,
   *   watch: HTMLElement[],
   *   getToggle: () => HTMLElement | null,
   * }} opts
   *   `watch` lists the elements whose size moves the anchor — the anchor
   *   itself and everything below it. `getToggle` is a getter because the
   *   status line re-renders and the toggle is re-created with it.
   * @returns {{toggle: () => void, place: () => void}}
   */
  function wireKeysPopover(opts) {
    var bar = opts.keysBar;
    var doc = bar.ownerDocument;
    var win = doc.defaultView;

    function isOpen() {
      return bar.classList.contains('mobile-open');
    }

    function place() {
      if (!isOpen()) return;
      var bottom = popoverBottom(
        doc.documentElement.clientHeight,
        opts.anchor.getBoundingClientRect().top,
      );
      bar.style.setProperty('--keys-popover-bottom', bottom + 'px');
    }

    function setOpen(open) {
      bar.classList.toggle('mobile-open', open);
      var toggle = opts.getToggle();
      if (toggle) toggle.classList.toggle('active', open);
      place();
    }

    if (typeof win.ResizeObserver === 'function') {
      var ro = new win.ResizeObserver(place);
      opts.watch.forEach(function (el) {
        if (el) ro.observe(el);
      });
    }
    win.addEventListener('resize', place);
    if (win.visualViewport) win.visualViewport.addEventListener('resize', place);

    // Capture phase, and no preventDefault: the tap still reaches whatever it
    // landed on (the composer, the terminal), it just closes the popover too.
    doc.addEventListener(
      'pointerdown',
      function (e) {
        if (!isOpen()) return;
        var toggle = opts.getToggle();
        if (bar.contains(e.target) || (toggle && toggle.contains(e.target))) return;
        setOpen(false);
      },
      true,
    );

    return {
      toggle: function () {
        setOpen(!isOpen());
      },
      place: place,
    };
  }

  var api = { popoverBottom: popoverBottom, wireKeysPopover: wireKeysPopover };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.wireKeysPopover = wireKeysPopover;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
