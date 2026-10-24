// Render sections from the canonical report so figures have one source.
for (const preview of document.querySelectorAll('[data-cohort-report]')) {
  const load = async () => {
    const response = await fetch(preview.dataset.cohortReport);
    if (!response.ok) throw new Error('Report unavailable');
    const report = new DOMParser().parseFromString(await response.text(), 'text/html');
    const sections = [...report.querySelectorAll('main > section.panel')];
    if (sections.length !== 3) throw new Error('Unexpected report structure');
    const labels = ['All ten nonprofits', 'Reliance on major funders', 'Funding options by area'];
    const tabs = document.createElement('div');
    tabs.className = 'report-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Sample report sections');
    const content = document.createElement('div');
    content.className = 'report-content';
    const buttons = [], panels = [];
    const select = (index, focus = false) => {
      buttons.forEach((button, i) => {
        button.setAttribute('aria-selected', String(i === index));
        button.tabIndex = i === index ? 0 : -1;
        panels[i].hidden = i !== index;
      });
      if (focus) buttons[index].focus();
    };
    sections.forEach((section, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `cohort-report-tab-${index}`;
      button.textContent = labels[index];
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `cohort-report-panel-${index}`);
      button.addEventListener('click', () => select(index));
      button.addEventListener('keydown', event => {
        let target;
        if (event.key === 'ArrowRight') target = (index + 1) % sections.length;
        if (event.key === 'ArrowLeft') target = (index + sections.length - 1) % sections.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = sections.length - 1;
        if (target !== undefined) { event.preventDefault(); select(target, true); }
      });
      const panel = document.createElement('div');
      panel.id = `cohort-report-panel-${index}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      panel.tabIndex = 0;
      panel.append(document.importNode(section, true));
      buttons.push(button); panels.push(panel);
      tabs.append(button); content.append(panel);
    });
    select(0);
    preview.querySelector('.report-tab-mount').replaceChildren(tabs, content);
  };
  // The complete-report link also works if JavaScript is disabled or loading fails.
  load().catch(() => {
    const status = document.createElement('p');
    status.textContent = 'Open the complete report below to view the sample.';
    preview.querySelector('.report-tab-mount').replaceChildren(status);
  });
}
