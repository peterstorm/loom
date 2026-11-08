// CALIBRATION: CAL-XSS-01
// A stored comment is written into the DOM as HTML, so markup in the comment
// executes for every reader of the page.
export function renderComment(el: HTMLElement, comment: string): void {
  el.innerHTML = comment;
}
