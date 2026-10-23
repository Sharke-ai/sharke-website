// Keep the canonical report readable in the page without a second vertical scrollbar.
for (const frame of document.querySelectorAll('.cohort-report-frame')) {
  const connect = () => {
    const report = frame.contentDocument;
    if (!report?.body) return;
    for (const link of report.querySelectorAll('a')) link.target = '_top';
    const resize = () => {
      const content = report.querySelector('main') || report.body;
      const height = Math.ceil(content.getBoundingClientRect().height);
      const margin = parseFloat(getComputedStyle(content).marginTop) + parseFloat(getComputedStyle(content).marginBottom);
      frame.style.height = `${height + margin + 4}px`;
    };
    resize();
    new ResizeObserver(resize).observe(report.querySelector('main') || report.body);
  };
  frame.addEventListener('load', connect);
  if (frame.contentDocument?.readyState === 'complete') connect();
}
