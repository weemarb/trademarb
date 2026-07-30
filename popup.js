(() => {
  const SETTINGS_DEFAULTS = {
    deleteUselessFooter: true,
    bagOfHolding: false,
  };

  function applySettingsToPopup(settings) {
    document.querySelectorAll(".toggle-input[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      input.checked = Boolean(settings[key]);
    });
  }

  function saveSetting(key, value) {
    chrome.storage.local.set({ [key]: value });
  }

  document.addEventListener("DOMContentLoaded", () => {
    chrome.storage.local.get(SETTINGS_DEFAULTS, (stored) => {
      applySettingsToPopup({ ...SETTINGS_DEFAULTS, ...stored });
    });

    document.querySelectorAll(".toggle-input[data-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        saveSetting(input.dataset.setting, input.checked);
      });
    });
  });
})();
