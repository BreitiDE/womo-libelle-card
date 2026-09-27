/**
 * WoMo Libelle Card
 * Wasserwaage (Libelle) für Home Assistant im Design des GC9A01-Displays
 * der ESPHome-Libelle. Zeigt Nick/Roll als Blase, Status und optional
 * einen Button zum Nullen.
 *
 * https://github.com/<DEIN-GITHUB-NAME>/womo-libelle-card
 * Lizenz: MIT
 */

const CARD_VERSION = "1.1.0";
const CARD_TAG = "womo-libelle-card";
const EDITOR_TAG = "womo-libelle-card-editor";

const DEFAULTS = {
  title: "",
  nick_entity: "sensor.technik_esp_womo_libelle_nick",
  roll_entity: "sensor.technik_esp_womo_libelle_roll",
  zero_entity: "",
  threshold_level: 0.5, // unter diesem Wert: waagerecht (grün)
  threshold_near: 1.5, // unter diesem Wert: fast gerade (gelb), darüber: ausrichten (rot)
  deg_per_ring: 1, // Grad pro Skalenring (innerer Ring = 1x, äußerer = 2x)
  size: 0, // 0 = automatisch volle Kartenbreite, sonst max. Breite in px
  front_label: "vorne",
  show_values: true,
  show_status: true,
  invert_nick: false, // vorne/hinten tauschen (Sensor liefert inverse Nick-Werte)
  invert_roll: false, // links/rechts tauschen (Sensor liefert inverse Roll-Werte)
};

// Farben wie im ESPHome-Display
const C = {
  face: "#000000",
  white: "#F1EFE8",
  label: "#B4B2A9",
  ring: "#5F5E5A",
  ringDark: "#444441",
  green: "#639922",
  greenTxt: "#97C459",
  amber: "#EF9F27",
  red: "#E24B4A",
  redTxt: "#F09595",
};

// Geometrie im 240x240-Koordinatensystem des Displays
const CX = 120;
const CY = 120;
const RING_PX = 36; // Abstand der Skalenringe in px
const MAX_R = 96; // maximaler Weg der Blase
const BUBBLE_R = 14;

const fmt = (v) => {
  const x = Math.abs(v) < 0.05 ? 0 : v;
  const s = Math.abs(x).toFixed(1);
  return (x < 0 ? "-" : " ") + s; // Leerzeichen statt Minus -> kein Zappeln
};

class WomoLibelleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._armed = false;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig(hass) {
    const cfg = { ...DEFAULTS };
    if (hass) {
      const ids = Object.keys(hass.states);
      const n = ids.find((e) => e.startsWith("sensor.") && e.endsWith("libelle_nick"));
      const r = ids.find((e) => e.startsWith("sensor.") && e.endsWith("libelle_roll"));
      const z = ids.find((e) => e.startsWith("button.") && e.includes("libelle") && e.includes("nullen") && !e.includes("zurucksetzen"));
      if (n) cfg.nick_entity = n;
      if (r) cfg.roll_entity = r;
      if (z) cfg.zero_entity = z;
    }
    return {
      nick_entity: cfg.nick_entity,
      roll_entity: cfg.roll_entity,
      zero_entity: cfg.zero_entity,
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Ungültige Konfiguration");
    const cfg = { ...DEFAULTS, ...config };
    if (!cfg.nick_entity || !cfg.roll_entity) {
      throw new Error("nick_entity und roll_entity müssen gesetzt sein");
    }
    cfg.threshold_level = Number(cfg.threshold_level) || DEFAULTS.threshold_level;
    cfg.threshold_near = Number(cfg.threshold_near) || DEFAULTS.threshold_near;
    cfg.deg_per_ring = Number(cfg.deg_per_ring) > 0 ? Number(cfg.deg_per_ring) : DEFAULTS.deg_per_ring;
    cfg.size = Number(cfg.size) || 0;
    this._config = cfg;
    this._render();
    if (this._hass) this._update();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._update();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: 6, min_columns: 3 };
  }

  // ---------------------------------------------------------------
  // Aufbau (einmalig pro Konfiguration)
  // ---------------------------------------------------------------
  _render() {
    const c = this._config;
    const ppd = RING_PX / c.deg_per_ring; // Pixel pro Grad
    const targetR = Math.max(4, Math.min(c.threshold_level * ppd, MAX_R));
    const d1 = +(c.deg_per_ring).toFixed(2);
    const d2 = +(c.deg_per_ring * 2).toFixed(2);
    // Ringbeschriftung auf 45° rechts oben
    const lbl = (r) => [CX + r * 0.707 + 3, CY - r * 0.707 - 3];
    const [l1x, l1y] = lbl(RING_PX);
    const [l2x, l2y] = lbl(RING_PX * 2);
    const maxW = c.size > 0 ? `${c.size}px` : "100%";

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; box-sizing: border-box; }
        .title { font-size: var(--ha-card-header-font-size, 20px); color: var(--primary-text-color); margin: 0 0 12px; line-height: 1.3; }
        .wrap { width: 100%; max-width: ${maxW}; margin: 0 auto; }
        svg { display: block; width: 100%; height: auto; }
        text { font-family: Roboto, "Noto Sans", sans-serif; }
        .mono { font-family: "Roboto Mono", ui-monospace, Menlo, Consolas, monospace; white-space: pre; }
        #bubble { transition: transform 0.4s ease-out, fill 0.3s; }
        .arrow { transition: opacity 0.3s; }
        .actions { display: flex; justify-content: center; margin-top: 12px; }
        button {
          font: inherit; font-size: 14px; cursor: pointer;
          padding: 8px 16px; border-radius: 18px;
          border: 1px solid var(--divider-color, #444);
          background: transparent; color: var(--primary-text-color);
          display: inline-flex; align-items: center; gap: 6px;
        }
        button:hover { background: var(--secondary-background-color); }
        button.armed { border-color: ${C.amber}; color: ${C.amber}; }
        ha-icon { --mdc-icon-size: 18px; }
      </style>
      <ha-card>
        ${c.title ? `<div class="title">${this._esc(c.title)}</div>` : ""}
        <div class="wrap">
          <svg viewBox="0 0 240 240" role="img" aria-label="Libelle">
            <circle cx="${CX}" cy="${CY}" r="120" fill="${C.face}"/>
            <circle cx="${CX}" cy="${CY}" r="108" fill="none" stroke="${C.ringDark}" stroke-width="2"/>
            <circle cx="${CX}" cy="${CY}" r="${RING_PX * 2}" fill="none" stroke="${C.ring}" stroke-width="1"/>
            <circle cx="${CX}" cy="${CY}" r="${RING_PX}" fill="none" stroke="${C.ring}" stroke-width="1"/>
            <circle cx="${CX}" cy="${CY}" r="${targetR}" fill="none" stroke="${C.green}" stroke-width="2"/>
            <line x1="12" y1="${CY}" x2="228" y2="${CY}" stroke="${C.ringDark}"/>
            <line x1="${CX}" y1="12" x2="${CX}" y2="228" stroke="${C.ringDark}"/>
            <text x="${CX}" y="32" fill="${C.label}" font-size="12" text-anchor="middle">${this._esc(c.front_label)}</text>
            <text x="${l2x}" y="${l2y}" fill="#888780" font-size="10">${d2}°</text>
            <text x="${l1x}" y="${l1y}" fill="#888780" font-size="10">${d1}°</text>

            <polygon id="aT" class="arrow" points="120,6 112,18 128,18" fill="${C.amber}" opacity="0"/>
            <polygon id="aB" class="arrow" points="120,234 112,222 128,222" fill="${C.amber}" opacity="0"/>
            <polygon id="aL" class="arrow" points="6,120 18,112 18,128" fill="${C.amber}" opacity="0"/>
            <polygon id="aR" class="arrow" points="234,120 222,112 222,128" fill="${C.amber}" opacity="0"/>

            <circle id="bubble" cx="${CX}" cy="${CY}" r="${BUBBLE_R}" fill="${C.ring}" stroke="${C.white}" stroke-width="2"/>

            ${c.show_values ? `
            <text id="tN" class="mono" x="84" y="176" fill="${C.white}" font-size="16" text-anchor="middle" xml:space="preserve">N --.-°</text>
            <text id="tR" class="mono" x="156" y="176" fill="${C.white}" font-size="16" text-anchor="middle" xml:space="preserve">R --.-°</text>` : ""}
            ${c.show_status ? `
            <text id="tS" x="${CX}" y="200" fill="${C.label}" font-size="13" text-anchor="middle">…</text>` : ""}
          </svg>
        </div>
        ${c.zero_entity ? `
        <div class="actions">
          <button id="zero" type="button"><ha-icon icon="mdi:crosshairs-gps"></ha-icon><span>Libelle nullen</span></button>
        </div>` : ""}
      </ha-card>
    `;

    this._el = {
      bubble: this.shadowRoot.getElementById("bubble"),
      tN: this.shadowRoot.getElementById("tN"),
      tR: this.shadowRoot.getElementById("tR"),
      tS: this.shadowRoot.getElementById("tS"),
      aT: this.shadowRoot.getElementById("aT"),
      aB: this.shadowRoot.getElementById("aB"),
      aL: this.shadowRoot.getElementById("aL"),
      aR: this.shadowRoot.getElementById("aR"),
      zero: this.shadowRoot.getElementById("zero"),
    };
    this._ppd = ppd;

    if (this._el.zero) {
      this._el.zero.addEventListener("click", () => this._onZero());
    }
    // Klick auf die Libelle öffnet den Verlauf von Nick
    this.shadowRoot.querySelector("svg").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: this._config.nick_entity }, bubbles: true, composed: true,
      }));
    });
  }

  // ---------------------------------------------------------------
  // Aktualisierung bei jedem hass-Update
  // ---------------------------------------------------------------
  _update() {
    const c = this._config;
    const e = this._el;
    if (!e || !e.bubble) return;

    const sn = this._hass.states[c.nick_entity];
    const sr = this._hass.states[c.roll_entity];
    // Vorzeichen bei Bedarf umdrehen (unabhängig voneinander)
    const n = (sn ? parseFloat(sn.state) : NaN) * (c.invert_nick ? -1 : 1);
    const r = (sr ? parseFloat(sr.state) : NaN) * (c.invert_roll ? -1 : 1);

    if (!Number.isFinite(n) || !Number.isFinite(r)) {
      e.bubble.style.transform = "translate(0px, 0px)";
      e.bubble.setAttribute("fill", C.ring);
      if (e.tN) e.tN.textContent = "N --.-°";
      if (e.tR) e.tR.textContent = "R --.-°";
      if (e.tS) { e.tS.textContent = !sn || !sr ? "Sensor fehlt" : "keine Daten"; e.tS.setAttribute("fill", C.redTxt); }
      for (const a of [e.aT, e.aB, e.aL, e.aR]) a.setAttribute("opacity", 0);
      return;
    }

    // Blase wandert zur hohen Seite (Nick+ = vorne hoch = oben)
    let bx = r * this._ppd;
    let by = -n * this._ppd;
    const m = Math.hypot(bx, by);
    if (m > MAX_R) { bx *= MAX_R / m; by *= MAX_R / m; }
    e.bubble.style.transform = `translate(${bx.toFixed(1)}px, ${by.toFixed(1)}px)`;

    const t = Math.max(Math.abs(n), Math.abs(r));
    let fill, txtCol, status;
    if (t < c.threshold_level) { fill = C.green; txtCol = C.greenTxt; status = "waagerecht"; }
    else if (t < c.threshold_near) { fill = C.amber; txtCol = C.amber; status = "fast gerade"; }
    else { fill = C.red; txtCol = C.redTxt; status = "ausrichten"; }
    e.bubble.setAttribute("fill", fill);

    if (e.tN) e.tN.textContent = `N${fmt(n)}°`;
    if (e.tR) e.tR.textContent = `R${fmt(r)}°`;
    if (e.tS) { e.tS.textContent = status; e.tS.setAttribute("fill", txtCol); }

    // Dreiecke: diese Seite anheben
    const L = c.threshold_level;
    e.aT.setAttribute("opacity", n <= -L ? 1 : 0); // vorne
    e.aB.setAttribute("opacity", n >= L ? 1 : 0); // hinten
    e.aL.setAttribute("opacity", r >= L ? 1 : 0); // links
    e.aR.setAttribute("opacity", r <= -L ? 1 : 0); // rechts
  }

  // Zweistufig: erster Klick scharf, zweiter Klick innerhalb 3 s nullt
  _onZero() {
    const btn = this._el.zero;
    const label = btn.querySelector("span");
    if (!this._armed) {
      this._armed = true;
      btn.classList.add("armed");
      label.textContent = "Wirklich nullen?";
      clearTimeout(this._armTimer);
      this._armTimer = setTimeout(() => this._disarm(), 3000);
      return;
    }
    this._disarm();
    const id = this._config.zero_entity;
    const domain = id.split(".")[0];
    const service = domain === "button" ? "press" : domain === "script" ? "turn_on" : "press";
    this._hass.callService(domain, service, { entity_id: id });
    label.textContent = "Genullt";
    setTimeout(() => { if (!this._armed) label.textContent = "Libelle nullen"; }, 1500);
  }

  _disarm() {
    this._armed = false;
    clearTimeout(this._armTimer);
    if (!this._el.zero) return;
    this._el.zero.classList.remove("armed");
    this._el.zero.querySelector("span").textContent = "Libelle nullen";
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
}

// -----------------------------------------------------------------
// Visueller Editor (nutzt das eingebaute ha-form von Home Assistant)
// -----------------------------------------------------------------
const SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "nick_entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "roll_entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "zero_entity", selector: { entity: { domain: ["button", "script"] } } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "threshold_level", selector: { number: { min: 0.1, max: 10, step: 0.1, mode: "box", unit_of_measurement: "°" } } },
      { name: "threshold_near", selector: { number: { min: 0.1, max: 20, step: 0.1, mode: "box", unit_of_measurement: "°" } } },
      { name: "deg_per_ring", selector: { number: { min: 0.25, max: 10, step: 0.25, mode: "box", unit_of_measurement: "°" } } },
      { name: "size", selector: { number: { min: 0, max: 1000, step: 10, mode: "box", unit_of_measurement: "px" } } },
    ],
  },
  { name: "front_label", selector: { text: {} } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "show_values", selector: { boolean: {} } },
      { name: "show_status", selector: { boolean: {} } },
      { name: "invert_nick", selector: { boolean: {} } },
      { name: "invert_roll", selector: { boolean: {} } },
    ],
  },
];

const LABELS = {
  title: "Titel (optional)",
  nick_entity: "Sensor Nick (vorne/hinten)",
  roll_entity: "Sensor Roll (links/rechts)",
  zero_entity: "Button „Libelle nullen“ (optional)",
  threshold_level: "Grenze waagerecht",
  threshold_near: "Grenze fast gerade",
  deg_per_ring: "Grad pro Ring",
  size: "Max. Breite (0 = auto)",
  front_label: "Beschriftung oben",
  show_values: "Winkel anzeigen",
  show_status: "Status anzeigen",
  invert_nick: "Vorne/hinten tauschen",
  invert_roll: "Links/rechts tauschen",
};

class WomoLibelleCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._renderForm();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    else this._renderForm();
  }

  _renderForm() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => LABELS[s.name] ?? s.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const cfg = { ...ev.detail.value };
        // leere optionale Felder entfernen
        for (const k of ["title", "zero_entity"]) if (!cfg[k]) delete cfg[k];
        this._config = cfg;
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: cfg }, bubbles: true, composed: true,
        }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = SCHEMA;
    this._form.data = { ...DEFAULTS, ...this._config };
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, WomoLibelleCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, WomoLibelleCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "WoMo Libelle",
    description: "Wasserwaage für das Wohnmobil im Design der ESPHome-Libelle",
    preview: true,
    documentationURL: "https://github.com/<DEIN-GITHUB-NAME>/womo-libelle-card",
  });
}

console.info(
  `%c WOMO-LIBELLE-CARD %c v${CARD_VERSION} `,
  "color:#000;background:#639922;font-weight:bold;",
  "color:#639922;background:#000;",
);
