"use client";

import { useState } from "react";

/** units: the default unit first, then units the database accepts as equivalent; other: a free-named test */
export interface LabTypeOpt { id: string; name: string; unit: string | null; units: string[]; kind: string; group: string; other: boolean }
export interface LabRowsText {
  test: string; result: string; unit: string; refLow: string; refHigh: string; refText?: string; refTextHint?: string; flag: string; add: string; remove: string; choose: string;
  flags: { value: string; label: string }[]; row: string; customName: string; customHint: string;
}

/** Repeating result rows for a lab report; field names r<N>_* are read by the addLabReport action. */
export function LabRows({ types, text }: { types: LabTypeOpt[]; text: LabRowsText }) {
  const [keys, setKeys] = useState<number[]>([0, 1, 2]);
  const [next, setNext] = useState(3);
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const groups = Array.from(new Set(types.map((x) => x.group)));
  return (
    <div className="stack">
      <datalist id="qualitative_presets">
        <option value="سلبي (Negative)" />
        <option value="إيجابي (Positive)" />
        <option value="طبيعي (Normal)" />
        <option value="أثر (Trace)" />
        <option value="عكر قليلاً (Slight Turbid)" />
      </datalist>
      {keys.map((k, i) => {
        const t = types.find((x) => x.id === chosen[k]);
        return (
          <fieldset key={k}>
            <legend>{text.row} {i + 1}</legend>
            <div className="form-grid">
              <div className="field wide">
                <label htmlFor={`r${k}_type`}>{text.test}</label>
                <select id={`r${k}_type`} name={`r${k}_type`} defaultValue="" onChange={(e) => setChosen({ ...chosen, [k]: e.target.value })}>
                  <option value="">{text.choose}</option>
                  {groups.map((g) => (
                    <optgroup key={g} label={g}>
                      {types.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.name}{x.unit ? ` (${x.unit})` : ""}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              {t?.other && (
                <div className="field wide"><label htmlFor={`r${k}_custom_name`}>{text.customName} <span className="req">*</span></label>
                  <input id={`r${k}_custom_name`} name={`r${k}_custom_name`} type="text" maxLength={120} required placeholder={text.customHint} /></div>
              )}
              <div className="field">
                <label htmlFor={`r${k}_value`}>{text.result}</label>
                <input
                  id={`r${k}_value`}
                  name={`r${k}_value`}
                  type="text"
                  inputMode={t?.kind === "text" ? "text" : "decimal"}
                  dir={t?.kind === "text" ? "auto" : "ltr"}
                  autoComplete="off"
                  list={t?.kind === "text" ? "qualitative_presets" : undefined}
                />
              </div>
              <div className="field"><label htmlFor={`r${k}_unit`}>{text.unit}</label><input id={`r${k}_unit`} name={`r${k}_unit`} type="text" dir="ltr" placeholder={t?.unit ?? ""} list={t && t.units.length > 1 ? `units_${k}` : undefined} />
                {t && t.units.length > 1 && <datalist id={`units_${k}`}>{t.units.map((u) => <option key={u} value={u} />)}</datalist>}</div>
              {t?.kind === "text" ? (
                <div className="field wide">
                  <label htmlFor={`r${k}_ref_text`}>{text.refText ?? "المرجع النصي"}</label>
                  <input id={`r${k}_ref_text`} name={`r${k}_ref_text`} type="text" placeholder={text.refTextHint ?? "مثال: Negative أو < 1.0"} />
                </div>
              ) : (
                <>
                  <div className="field"><label htmlFor={`r${k}_ref_low`}>{text.refLow}</label><input id={`r${k}_ref_low`} name={`r${k}_ref_low`} type="text" inputMode="decimal" dir="ltr" /></div>
                  <div className="field"><label htmlFor={`r${k}_ref_high`}>{text.refHigh}</label><input id={`r${k}_ref_high`} name={`r${k}_ref_high`} type="text" inputMode="decimal" dir="ltr" /></div>
                </>
              )}
              <div className="field"><label htmlFor={`r${k}_flag`}>{text.flag}</label>
                <select id={`r${k}_flag`} name={`r${k}_flag`} defaultValue="">{text.flags.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select>
              </div>
            </div>
            {keys.length > 1 && (
              <button type="button" className="btn danger sm" style={{ marginBlockStart: ".5rem" }} onClick={() => setKeys(keys.filter((x) => x !== k))}>{text.remove}</button>
            )}
          </fieldset>
        );
      })}
      <div><button type="button" className="btn sm" onClick={() => { setKeys([...keys, next]); setNext(next + 1); }}>+ {text.add}</button></div>
    </div>
  );
}
