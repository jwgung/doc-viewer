// 화면 아래에서 올라오는 입력 시트. 쪽 이동과 암호 입력에 쓴다.
// 확인하면 입력값을, 취소하거나 바깥을 누르면 null을 돌려준다.
export function openSheet({ title, message = '', inputType = 'text', inputMode, value = '', min, max, suffix = '', confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    document.querySelector('.sheet-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML =
      '<form class="sheet"><h2></h2><p></p><div class="sheet-field"><input><span></span></div>' +
      '<div class="sheet-actions"><button type="button" class="sheet-cancel"></button><button type="submit" class="sheet-confirm"></button></div></form>';
    const form = backdrop.querySelector('form');
    form.querySelector('h2').textContent = title;
    form.querySelector('p').textContent = message;
    form.querySelector('.sheet-field span').textContent = suffix;
    form.querySelector('.sheet-cancel').textContent = cancelLabel;
    form.querySelector('.sheet-confirm').textContent = confirmLabel;
    const input = form.querySelector('input');
    input.type = inputType;
    input.autocomplete = 'off';
    if (inputMode) input.inputMode = inputMode;
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.value = String(value);

    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };
    backdrop.addEventListener('click', (event) => event.target === backdrop && close(null));
    form.querySelector('.sheet-cancel').addEventListener('click', () => close(null));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      close(input.value);
    });
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));
    input.focus();
    input.select();
    dispatchEvent(new Event('viewerinputopen'));
  });
}
