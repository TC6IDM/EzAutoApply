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

/**
 * Workday's "How did you hear about us?" prompt, as it behaves for a person: opening
 * it shows categories; typing does nothing until Enter searches; the top result is
 * highlighted (aria-selected) but not chosen; clicking a result does nothing; a second
 * Enter (after ArrowDown to move the highlight) chooses it, shown as a pill.
 */
export function mountWorkdaySearchPrompt(container: HTMLElement, label: string, categories: string[], results: Record<string, string[]>) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div data-automation-id="formField-source">
      <label for="wd-prompt">${label}</label>
      <div class="prompt">
        <div class="pills"></div>
        <input id="wd-prompt" role="combobox" placeholder="Search" aria-controls="wd-prompt-list" aria-autocomplete="list">
      </div>
      <div id="wd-prompt-list" role="listbox" hidden></div>
    </div>`;
  container.appendChild(wrap);
  const input = wrap.querySelector('input')!;
  const list = wrap.querySelector<HTMLElement>('#wd-prompt-list')!;
  const pills = wrap.querySelector<HTMLElement>('.pills')!;
  let shownResults: string[] = [];
  let highlighted = 0;
  const highlight = () =>
    Array.from(list.children).forEach((o, i) => o.setAttribute('aria-selected', String(shownResults.length > 0 && i === highlighted)));
  const show = (items: string[], areResults: boolean) => {
    list.innerHTML = '';
    shownResults = areResults ? items : [];
    highlighted = 0;
    for (const text of items) {
      const o = document.createElement('div');
      o.setAttribute('role', 'option');
      o.setAttribute('data-automation-label', text);
      // The visible text sits in an aria-hidden node, as on Workday. Clicks are ignored.
      o.innerHTML = `<span aria-hidden="true">${text}</span>${areResults ? '' : ' <span aria-hidden="true">›</span>'}`;
      list.appendChild(o);
    }
    highlight();
    list.hidden = false;
  };
  input.addEventListener('mousedown', () => show(categories, false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && shownResults.length) {
      highlighted = Math.min(highlighted + 1, shownResults.length - 1);
      highlight();
    } else if (e.key === 'Enter' && shownResults.length) {
      pills.textContent = shownResults[highlighted];
      input.value = '';
      list.hidden = true;
      shownResults = [];
    } else if (e.key === 'Enter') {
      show(results[input.value.trim().toLowerCase()] ?? [], true);
    }
  });
  return { chosen: () => pills.textContent ?? '' };
}

/**
 * Workday's "Select One" dropdown, at its most awkward: it toggles open on
 * mousedown *and* on click (so a full click leaves it closed), ignores clicks on
 * options, and selects with the keyboard: type-ahead, then Enter. `rendered`
 * limits how many options are in the DOM at once, like a virtualized long list.
 */
let selectCount = 0;
export function mountWorkdaySelect(
  container: HTMLElement,
  label: string,
  options: string[],
  opts: { rendered?: number; workdayNaming?: boolean } = {},
) {
  const n = ++selectCount;
  const wrap = document.createElement('div');
  // workdayNaming: the button's accessible name is "Select One Required" and the question
  // is a <label> elsewhere in the field's formField container, as on real Workday pages.
  wrap.innerHTML = opts.workdayNaming
    ? `<div data-automation-id="formField-q${n}"><label>${label}</label><div>
         <button type="button" aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
       </div><ul class="wd-list" role="listbox" tabindex="-1" hidden></ul></div>`
    : `<label id="wd-select-label-${n}">${label}</label>
       <button type="button" aria-haspopup="listbox" aria-labelledby="wd-select-label-${n}">Select One</button>
       <ul class="wd-list" role="listbox" tabindex="-1" hidden></ul>`;
  container.appendChild(wrap);
  const button = wrap.querySelector('button')!;
  const list = wrap.querySelector<HTMLElement>('ul')!;
  let highlighted = -1;
  let typed = '';
  const items = options.map((text, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.tabIndex = -1;
    li.textContent = text;
    if (i < (opts.rendered ?? options.length)) list.appendChild(li);
    return li;
  });
  const toggle = () => {
    list.hidden = !list.hidden;
    if (!list.hidden) list.focus();
  };
  const select = (i: number) => {
    button.textContent = options[i];
    list.hidden = true;
    button.focus();
  };
  button.addEventListener('mousedown', toggle);
  button.addEventListener('click', toggle);
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const i = items.indexOf(e.target as HTMLLIElement);
      if (i >= 0) select(i);
      else if (highlighted >= 0) select(highlighted);
    } else if (e.key.length === 1) {
      typed += e.key.toLowerCase();
      highlighted = options.findIndex((o) => o.toLowerCase().startsWith(typed));
    }
  });
  return { chosen: () => (button.textContent === 'Select One' ? '' : button.textContent), list, button };
}
