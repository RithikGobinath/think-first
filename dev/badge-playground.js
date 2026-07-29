(function () {
  "use strict";

  // Keep in sync with the :root block in src/overlay.css. min/max/step are
  // playground-only conveniences - the CSS itself has no hard limits.
  const VARS = [
    { name: "--ctf-badge-gap", label: "Badge gap", default: 10, min: 0, max: 24, unit: "px" },
    { name: "--ctf-badge-padding-y", label: "Badge padding (vertical)", default: 5, min: 0, max: 20, unit: "px" },
    { name: "--ctf-badge-padding-x", label: "Badge padding (horizontal)", default: 13, min: 0, max: 30, unit: "px" },
    { name: "--ctf-badge-radius", label: "Badge corner radius", default: 999, min: 0, max: 999, unit: "px" },
    { name: "--ctf-badge-border-width", label: "Badge border width", default: 2, min: 0, max: 6, step: 0.5, unit: "px" },
    { name: "--ctf-badge-font-size", label: "Badge font size", default: 18, min: 8, max: 28, unit: "px" },
    { name: "--ctf-seconds-font-size", label: "Seconds font size", default: 18, min: 8, max: 32, unit: "px" },
    { name: "--skip-padding-y", label: "Skip button padding (vertical)", default: 3, min: 0, max: 16, unit: "px" },
    { name: "--skip-padding-x", label: "Skip button padding (horizontal)", default: 9, min: 0, max: 24, unit: "px" },
    { name: "--skip-radius", label: "Skip button corner radius", default: 999, min: 0, max: 999, unit: "px" },
    { name: "--skip-font-size", label: "Skip button font size", default: 12, min: 8, max: 24, unit: "px" },
  ];

  const root = document.documentElement;
  const board = document.getElementById("board");
  const slidersEl = document.getElementById("sliders");
  const output = document.getElementById("output");

  for (let i = 0; i < 64; i++) board.appendChild(document.createElement("div"));

  function currentValues() {
    return VARS.reduce((acc, v) => {
      acc[v.name] = getComputedStyle(root).getPropertyValue(v.name).trim() || `${v.default}${v.unit}`;
      return acc;
    }, {});
  }

  function buildOutput() {
    const values = currentValues();
    const lines = VARS.map((v) => `  ${v.name}: ${values[v.name]};`).join("\n");
    output.value = `:root {\n${lines}\n}`;
  }

  VARS.forEach((v) => {
    const row = document.createElement("div");
    row.className = "dp-slider-row";
    row.innerHTML = `
      <label>
        <span>${v.label}</span>
        <span class="dp-slider-value" id="val-${v.name}">${v.default}${v.unit}</span>
      </label>
      <input type="range" id="range-${v.name}" min="${v.min}" max="${v.max}" step="${v.step || 1}" value="${v.default}" />
    `;
    slidersEl.appendChild(row);

    const range = row.querySelector("input");
    const valueLabel = row.querySelector(".dp-slider-value");
    range.addEventListener("input", () => {
      const value = `${range.value}${v.unit}`;
      root.style.setProperty(v.name, value);
      valueLabel.textContent = value;
      buildOutput();
    });
  });

  document.getElementById("resetBtn").addEventListener("click", () => {
    VARS.forEach((v) => {
      root.style.removeProperty(v.name);
      document.getElementById(`range-${v.name}`).value = v.default;
      document.getElementById(`val-${v.name}`).textContent = `${v.default}${v.unit}`;
    });
    buildOutput();
  });

  document.getElementById("copyBtn").addEventListener("click", () => {
    buildOutput();
    output.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(output.value).catch(() => {});
    } else {
      document.execCommand("copy");
    }
  });

  buildOutput();
})();
