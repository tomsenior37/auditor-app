# Auditor App — Template Authoring Guide

This document is the authoritative spec for producing an audit template that
can be imported into the Auditor App via **Templates → Upload Template**
(accepts `.json`).

Hand this whole file to an LLM along with the source material (standard,
procedure, checklist, etc.) and ask it to return **one JSON object** that
conforms to the schema below. Save that JSON to a `.json` file and upload it.

---

## 1. Top-level template object

```jsonc
{
  "name": "Machine Guard Audit",              // REQUIRED. Short human title.
  "standard": "AS/NZS 4024.1601:2014",        // Optional. Standard/reference.
  "description": "Checklist for fixed and movable guards.", // Optional.
  "requiresComponent": true,                  // Optional. If true, inspectors must pick a component (e.g. Guard).
  "componentType": "Guard",                   // Optional. Label for the component picker.
  "scoringEnabled": false,                    // Optional. Enables per-option scoring for multichoice.
  "version": 2,                               // REQUIRED. Always 2 for this schema.
  "items": [ /* sections + questions, in display order — see §2 */ ],
  "questions": [ /* flat list for legacy reports — see §4 */ ]
}
```

Minimum required fields: `name`, `version` (=2), `items`, `questions`.

---

## 2. `items` array — sections and questions in order

Each entry has a unique string `id` and an `itemType` of either
`"section"` or `"question"`. Order in the array = display order. Questions
belong to the nearest preceding section via their `sectionId`.

### 2.1 Section

```json
{ "id": "sec-general", "itemType": "section", "title": "General Condition" }
```

### 2.2 Question — common fields (all types)

```jsonc
{
  "id": "q-guard-present",          // REQUIRED. Unique within the template.
  "itemType": "question",           // REQUIRED.
  "sectionId": "sec-general",       // REQUIRED. Must match a section id above.
  "type": "yesno",                  // REQUIRED. See §3 for allowed values.
  "text": "Is the guard present and correctly positioned?", // REQUIRED.
  "hint": "Check all four sides.", // Optional short helper text.
  "required": true,                 // Optional. Default true.
  "allowNA": false,                 // Optional. Adds an N/A option (yesno only).
  "commentOnFail": true,            // Optional. Prompts for a comment on failing answer.
  "photoRequired": false,           // Optional. Forces a photo attachment.
  "allowPhoto": true,               // Optional. Shows the photo-attach control.
  "logic": [ /* see §5 */ ],        // Optional. Branching rules.
  "media": [                        // Optional. Images/PDFs shown with the question.
    { "kind": "image", "url": "/template-media/abc.png", "caption": "Wiring diagram" },
    { "kind": "pdf",   "url": "/template-media/spec.pdf", "caption": "Manufacturer spec" }
  ]
}
```

**Media URLs**: supply URLs to already-uploaded assets (use the Templates UI to upload),
or omit `media` entirely. `kind` is `"image"` or `"pdf"`. Each entry may include
an optional `caption`.

---

## 3. Question types and their type-specific fields

| `type`        | Extra fields                                   | Notes |
|---------------|------------------------------------------------|-------|
| `yesno`       | —                                              | Answers: YES / NO (and N/A if `allowNA`). NO = fail. |
| `multichoice` | `options: [{id, label, flagFail, score?}]`, `multiSelect?` | One option per choice. `flagFail: true` marks a failing option. `score` only used if `scoringEnabled`. Set `multiSelect: true` to let inspectors pick more than one option — the stored answer becomes an array of option ids, and any selected option with `flagFail: true` fails the question. |
| `text`        | `maxLength` (default 500)                      | Free text answer. |
| `number`      | `unit`, `min`, `max`                           | Numeric answer; `min`/`max` optional bounds. |
| `slider`      | `min` (default 0), `max` (default 100), `unit` | Slider; use for scales like 0–10. |
| `instruction` | —                                              | Display-only block (no answer). Use for safety notes/headings inline. |

**Multichoice example:**
```json
{
  "id": "q-damage-level",
  "itemType": "question",
  "sectionId": "sec-general",
  "type": "multichoice",
  "text": "Damage level observed",
  "options": [
    { "id": "opt-none",  "label": "None",           "flagFail": false },
    { "id": "opt-minor", "label": "Minor cosmetic", "flagFail": false },
    { "id": "opt-major", "label": "Major / unsafe", "flagFail": true  }
  ]
}
```

---

## 4. `questions` flat list (compatibility)

Alongside `items`, include a parallel flat array used by CSV exports and
legacy reports. Order must match display order of the questions.

```json
"questions": [
  { "id": "q1", "text": "Is the guard present and correctly positioned?", "type": "yesno", "required": true },
  { "id": "q2", "text": "Damage level observed",                          "type": "multichoice", "required": true }
]
```

The `id`s here are sequential (`q1`, `q2`, …) and are independent of the
`items` ids — they are the legacy keys used by older reports.

---

## 5. Logic rules (`logic` on a question)

A question can trigger actions based on its own answer. Each entry in
`logic` is a rule `{ condition, conditionValue, action, targetIds, actionTitle }`.

### 5.1 Conditions — depend on the source question type

| Source type   | Allowed `condition` values                                             | `conditionValue` |
|---------------|------------------------------------------------------------------------|------------------|
| `yesno`       | `is_yes`, `is_no`                                                      | unused |
| `multichoice` | `is_fail`, `is_<optionId>` (one per option)                            | unused |
| `number`, `slider` | `less_than`, `equal_to`, `greater_than`, `between`                | required. For `between`, use `"min,max"` (e.g. `"10,20"`). |
| `text`        | `is_empty`, `is_not_empty`, `contains`                                 | required for `contains`. |
| any           | `answered`, `not_answered`                                             | unused |

### 5.2 Actions

| `action`          | Behaviour                                                | Extra fields |
|-------------------|----------------------------------------------------------|--------------|
| `show_question`   | Reveal one or more hidden questions when condition met.  | `targetIds: ["<question-id>", …]` (ids from `items`) |
| `require_photo`   | Force a photo on the source question when condition met. | — |
| `require_note`    | Force a comment on the source question when condition met. | — |
| `set_fail`        | Automatically fail the whole inspection.                 | — |
| `require_action`  | Prompt the inspector to perform an action.               | `actionTitle: "e.g. Lock out machine"` |

Questions referenced by `show_question` targets should exist in `items` and
will start hidden until the rule fires.

### 5.3 Example

```json
{
  "id": "q-fail-root-cause",
  "itemType": "question", "sectionId": "sec-general", "type": "text",
  "text": "Describe the root cause of the failure.", "required": true
}
```
then on the source question:
```json
"logic": [
  { "condition": "is_no", "conditionValue": "", "action": "show_question",
    "targetIds": ["q-fail-root-cause"], "actionTitle": "" },
  { "condition": "is_no", "conditionValue": "", "action": "require_photo",
    "targetIds": [], "actionTitle": "" },
  { "condition": "is_no", "conditionValue": "", "action": "set_fail",
    "targetIds": [], "actionTitle": "" }
]
```

---

## 6. Full minimal working example

```json
{
  "name": "Quick Guard Check",
  "standard": "AS/NZS 4024.1601:2014",
  "description": "Abbreviated guard inspection.",
  "requiresComponent": true,
  "componentType": "Guard",
  "scoringEnabled": false,
  "version": 2,
  "items": [
    { "id": "sec-1", "itemType": "section", "title": "Physical condition" },
    {
      "id": "qa", "itemType": "question", "sectionId": "sec-1",
      "type": "yesno", "text": "Guard present and correctly positioned?",
      "required": true, "commentOnFail": true,
      "logic": [
        { "condition": "is_no", "conditionValue": "", "action": "require_photo",
          "targetIds": [], "actionTitle": "" },
        { "condition": "is_no", "conditionValue": "", "action": "set_fail",
          "targetIds": [], "actionTitle": "" }
      ]
    },
    {
      "id": "qb", "itemType": "question", "sectionId": "sec-1",
      "type": "multichoice", "text": "Condition",
      "options": [
        { "id": "opt-ok",   "label": "OK",            "flagFail": false },
        { "id": "opt-wear", "label": "Visible wear",  "flagFail": false },
        { "id": "opt-dmg",  "label": "Damaged",       "flagFail": true  }
      ]
    },
    { "id": "sec-2", "itemType": "section", "title": "Signatures" },
    {
      "id": "qc", "itemType": "question", "sectionId": "sec-2",
      "type": "text", "text": "Notes", "required": false, "maxLength": 500
    }
  ],
  "questions": [
    { "id": "q1", "text": "Guard present and correctly positioned?", "type": "yesno",       "required": true  },
    { "id": "q2", "text": "Condition",                               "type": "multichoice", "required": true  },
    { "id": "q3", "text": "Notes",                                   "type": "text",        "required": false }
  ]
}
```

---

## 7. Rules the importer enforces

- `name` and `questions` are REQUIRED or upload is rejected.
- `version` must be `2` for the new-style builder to render; older templates
  (without `items`) still import but display as a flat list.
- All `id`s must be unique within the template.
- Every `question` `sectionId` must reference a preceding `section` in `items`.
- Every `targetIds` value in `logic` must match a question `id` in `items`.
- Keep `items` order = desired display order.

---

## 8. Prompt to give another AI

> You are given the source material below (a standard, SOP, or checklist).
> Produce **one JSON object** that conforms to the Auditor App Template
> Schema (version 2) described in this guide. Output the JSON only, no
> surrounding prose or markdown fences. Ensure:
> (a) every question has a unique `id`;
> (b) every question has a valid `sectionId` pointing to a preceding section;
> (c) the `questions` flat array mirrors the question order from `items`
>     with sequential ids `q1`, `q2`, …;
> (d) failing answers that warrant a photo or auto-fail use the `logic`
>     rules `require_photo` / `set_fail`;
> (e) multichoice options use unique `id`s and set `flagFail: true` only on
>     genuinely non-compliant choices.
>
> Source material: <paste the checklist / standard here>
