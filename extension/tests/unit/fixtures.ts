/** HTML that imitates the ways real application forms build their fields. */

export const GREENHOUSE_LIKE = `
<form id="application">
  <h2>Personal information</h2>
  <div class="field"><label for="first_name">First Name <span aria-hidden="true">*</span></label><input id="first_name" name="first_name" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
  <div class="field"><label>Email <input type="email" name="email" required></label></div>
  <div class="field"><span id="phone-label">Phone</span><input aria-labelledby="phone-label" type="tel" name="phone"></div>
  <div class="field">
    <div class="label">Location (City)</div>
    <div><input name="location" autocomplete="off"></div>
  </div>
  <div class="field">
    <label for="resume">Resume/CV</label>
    <div class="dropzone"><button type="button">Attach</button><input type="file" id="resume" name="resume" style="display:none"></div>
  </div>
  <div class="field"><label for="li">LinkedIn Profile</label><input id="li" name="question_1"></div>

  <h2>Questions</h2>
  <fieldset>
    <legend>Are you legally authorized to work in the United States? *</legend>
    <label><input type="radio" name="q_auth" value="1"> Yes</label>
    <label><input type="radio" name="q_auth" value="0"> No</label>
  </fieldset>
  <div class="question">
    <p>Will you now or in the future require sponsorship for employment visa status?</p>
    <input type="radio" name="q_sponsor" value="y" id="sy"><label for="sy">Yes</label>
    <input type="radio" name="q_sponsor" value="n" id="sn"><label for="sn">No</label>
  </div>
  <div class="field">
    <label for="degree">Highest degree completed</label>
    <select id="degree" name="degree">
      <option value="">Select...</option>
      <option value="hs">High School</option>
      <option value="ba">Bachelor's Degree</option>
      <option value="ma">Master's Degree</option>
    </select>
  </div>
  <div class="field">
    <label for="why">Why do you want to work at Initech? *</label>
    <textarea id="why" name="why" required></textarea>
  </div>
  <div class="field">
    <label for="fav">What is your favorite color?</label>
    <input id="fav" name="fav">
  </div>
  <div class="field">
    <label><input type="checkbox" name="consent"> I agree to the privacy policy</label>
  </div>

  <h2>Voluntary Self-Identification</h2>
  <div class="field">
    <label for="veteran">Veteran Status</label>
    <select id="veteran" name="veteran">
      <option value="">Please select</option>
      <option>I am a protected veteran</option>
      <option>I am not a protected veteran</option>
      <option>I don't wish to answer</option>
    </select>
  </div>
  <fieldset>
    <legend>Race (select all that apply)</legend>
    <label><input type="checkbox" name="race" value="asian"> Asian</label>
    <label><input type="checkbox" name="race" value="white"> White</label>
    <label><input type="checkbox" name="race" value="decline"> Decline to self-identify</label>
  </fieldset>

  <input type="hidden" name="token" value="abc">
  <div style="display:none"><label for="hidden_field">Hidden</label><input id="hidden_field"></div>
  <button type="submit">Submit application</button>
</form>
`;

/** A react-select-style combobox whose options render only after it opens. */
export function mountCombobox(container: HTMLElement, label: string, options: string[]): HTMLInputElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label id="cb-label">${label}</label>
    <div class="select__control">
      <input role="combobox" aria-labelledby="cb-label" aria-expanded="false" aria-controls="cb-list" aria-autocomplete="list">
    </div>
    <div id="cb-list" role="listbox" hidden></div>`;
  container.appendChild(wrap);
  const input = wrap.querySelector('input')!;
  const list = wrap.querySelector<HTMLElement>('#cb-list')!;
  const render = (filter: string) => {
    list.innerHTML = '';
    for (const o of options.filter((x) => x.toLowerCase().includes(filter.toLowerCase()))) {
      const el = document.createElement('div');
      el.setAttribute('role', 'option');
      el.textContent = o;
      el.addEventListener('click', () => {
        input.value = '';
        input.dataset.selected = o;
        list.hidden = true;
      });
      list.appendChild(el);
    }
  };
  input.addEventListener('mousedown', () => {
    render('');
    list.hidden = false;
  });
  input.addEventListener('input', () => {
    render(input.value);
    list.hidden = false;
  });
  return input;
}

/**
 * Mimic React's controlled input: the instance gets its own `value` property,
 * and a plain `el.value = x` assignment is swallowed by the tracker.
 */
export function makeReactLike(input: HTMLInputElement): { committed: () => string } {
  let committed = '';
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')!;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return desc.get!.call(this);
    },
    set(_v: string) {
      // React's tracker records the value but the DOM state is driven by onChange.
    },
  });
  input.addEventListener('input', () => {
    committed = desc.get!.call(input);
  });
  return { committed: () => committed };
}
