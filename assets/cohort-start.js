(() => {
  const form = document.getElementById('cohort-form');
  const status = document.getElementById('request-status');
  const submit = document.getElementById('submit-scope');
  const params = new URLSearchParams(location.search);
  const audience = document.getElementById('audience');
  if (params.get('for') === 'association') audience.value = 'association';
  const size = params.get('size');
  if (size === '5' || size === '10') form.querySelector('input[value="' + size + '"]').checked = true;
  function updateBackLink() { document.getElementById('back-link').href = audience.value === 'association' ? '/associations' : '/foundations'; }
  audience.addEventListener('change', updateBackLink);
  updateBackLink();
  // Keep the same ID for a retry of the same payload, including a lost acknowledgement.
  // Store no contact details in browser storage.
  let attempt = null;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity() || submit.disabled) return;
    const values = Object.fromEntries(new FormData(form).entries());
    if (!['5', '10'].includes(values.size) || !['foundation', 'association'].includes(values.audience)) return;
    const identity = JSON.stringify(values);
    if (!attempt || attempt.identity !== identity) attempt = { identity, id: 'cohort_scope_' + crypto.randomUUID() };
    const payload = {
      plan: 'cohort_scope', stripe_session_id: attempt.id,
      first_name: values.contact_name.trim(), email: values.email.trim(), org_name: values.org_name.trim(),
      org_website: values.org_website.trim(), funder_type: values.audience, tier: values.size,
      grants_in_motion: values.members.trim(), notes: values.notes.trim(),
      program_summary: 'COHORT SCOPE REQUEST ONLY. No charge, signature, or enrollment. Buyer: ' + values.audience +
        '. Organizations: ' + values.size + '. Annual total: $' + (values.size === '5' ? '5,025' : '9,500') +
        '. Contact: ' + values.contact_name.trim() + '. Named organizations: ' + (values.members.trim() || 'To follow') +
        '. Notes: ' + values.notes.trim()
    };
    submit.disabled = true;
    submit.textContent = 'Sending your request...';
    status.textContent = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/.netlify/functions/submit-intake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error('Not acknowledged');
      document.getElementById('confirmation-email').textContent = payload.email;
      document.getElementById('request-reference').textContent = 'Request reference: ' + attempt.id;
      form.hidden = true;
      const success = document.getElementById('request-success');
      success.hidden = false;
      success.focus();
    } catch {
      status.textContent = 'We could not confirm your request was recorded. Your entries are still here. Please try again, or email collin@sharke.ai. Retrying this request will not create a second request.';
      status.focus();
    } finally {
      clearTimeout(timer);
      submit.disabled = false;
      submit.textContent = 'Request my cohort scope';
    }
  });
})();
