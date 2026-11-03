# Client Onboarding & Assessment — Field Matrix

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Purpose | Complete field inventory with current location, input, mandatory status, validation, target owner, and migration impact. |
| Rule | One data point = one owner = one source of truth. Snapshots are evidence, not competing live values. |
| Status | Ownership target with Phases 0–3 enforced and Phase 4 verified against a synthetic production-shaped fixture. No schema change has been made. See §16 and `../implementation/PHASE4-PRODUCTION-INTEGRITY-REPORT.md`. |

## Legend

| Code | Meaning |
|---|---|
| **R** | Required for the module to be complete |
| **O** | Optional |
| **C** | Conditional (condition stated) |
| **UI-R** | Required in the UI, optional in the API today |
| **Legacy** | Column exists and is read as a fallback; no new writes in the target |
| **Snapshot** | Write-once evidence value; never refreshed from the live profile |
| **Derived** | Computed server-side from owned inputs; never accepted from a client |

Migration impact values: `none` (no schema change), `stop-write` (code only), `deprecate` (stop-write plus later cleanup), `additive` (new nullable column), `backfill` (data migration), `index` (performance/constraint only).

---

## 1. Add Client

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Full name | `pt_clients.name` | text | R | — | 1–255; UI min 3 | Add Client | none |
| Gender | `pt_clients.gender` | select | R (UI), O (API) | — | max 20; UI enum Male/Female/Other | Add Client | none; align API to UI |
| Date of birth | `pt_clients.dob` (TEXT) | date | O | — | UI: real date, not future, age 10–100; API: any string | Add Client | none; parse/validate on write |
| Mobile | `pt_clients.mobile` | tel | R (UI), O (API) | — | Indian mobile `^[6-9]\d{9}$` | Add Client | none; align API |
| WhatsApp | `pt_clients.whatsapp` | tel | O | — | same Indian mobile regex | Add Client | none |
| Email | `pt_clients.email` | email | O | — | email format | Add Client | none |
| Emergency contact name | `pt_clients.emergency_contact` | text | O | Required if phone present | max 255 | Add Client | none |
| Emergency phone | `pt_clients.emergency_phone` | tel | O | Required if name present | Indian mobile regex | Add Client | none; align with consent/PAR-Q |
| Emergency relationship | `pt_clients.emergency_contact_relationship` | text | C | Required if contact or phone present | max 100; UI requires | Add Client | none |
| Address | `pt_clients.address` | textarea | O | — | max 1000 | Add Client | none |
| Occupation | `pt_clients.occupation` | text | O | — | max 100 | Lifestyle | deprecate; stop writing |
| Client source | `pt_clients.client_source` | select | O | — | closed set Walk-in, Instagram, WhatsApp, Referral, Existing Member, Google, Website, Other; blank allowed | Add Client | none |
| Trainer assignment | `pt_clients.trainer_id` / `trainer_name` | select | O | — | resolved to a studio trainer | Add Client | none |
| Enrolment term / package | `pt_clients.pt_start_date`, `pt_end_date`, `duration_months`, package amounts, `pt_package_id` | date/number/select | C | Enrolment only; create with a package is refused until screening | dates, amounts, duration 1–120 | Add Client | none |
| Goal | `pt_clients.goal` | text | Legacy | — | max 100 | Goal Assessment (active `pt_goals`) | deprecate |
| Height | `pt_clients.height` | number | Legacy | — | 50–250 | Fitness Testing | deprecate |
| Weight | `pt_clients.weight` | number | Legacy | — | 20–350 | Fitness Testing | deprecate; cache rule fix |
| Body fat | `pt_clients.body_fat` | number | Legacy | — | 3–70 | Fitness Testing | deprecate |
| Health conditions | `pt_clients.health_conditions` | textarea | Legacy | — | max 500 | PAR-Q | deprecate |
| Injuries | `pt_clients.injuries` | textarea | Legacy | — | max 500 | PAR-Q (history) / Interview (current narrative) | deprecate |
| Sessions per week | `pt_clients.sessions_per_week` | number | O | — | 1–7 integer | Add Client / enrolment | none; availability fallback |
| Workout experience | `pt_clients.workout_experience_level` | select | O | — | beginner/intermediate/advanced/athlete | Add Client / enrolment | none; Lifestyle stops writing |
| Notes | `pt_clients.notes` | textarea | O | — | max 2000 | Add Client | none |

---

## 2. Informed Consent

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client id | `pt_informed_consents.client_id` | hidden | R | — | FK `pt_clients`, tenant-scoped | Consent | none |
| Trainer id | `pt_informed_consents.trainer_id` | hidden | O | — | FK `trainers` | Consent | none |
| Version | `pt_informed_consents.version` | number | R | — | default 1; increment on edit of completed | Consent | none |
| Previous version | `pt_informed_consents.previous_version_id` | hidden | C | On version > 1 | FK self | Consent | none |
| Status | `pt_informed_consents.status` | enum | R | — | draft, pending_client_signature, pending_trainer_signature, completed, revoked, expired, archived | Consent | none; use or remove pending states |
| Full name snapshot | `pt_informed_consents.full_name` | text | R | Auto-filled from client | max 255 | Consent (Snapshot) | none |
| Gender snapshot | `pt_informed_consents.gender` | select | O | — | max 20 | Consent (Snapshot) | none |
| DOB snapshot | `pt_informed_consents.dob` | date | O | — | date | Consent (Snapshot) | none |
| Mobile snapshot | `pt_informed_consents.mobile` | tel | O | — | max 20 | Consent (Snapshot) | none |
| Email snapshot | `pt_informed_consents.email` | email | O | — | email, max 255 | Consent (Snapshot) | none |
| Emergency contact snapshot | `pt_informed_consents.emergency_contact` | text | O | — | max 255 | Consent (Snapshot) | none |
| Emergency phone snapshot | `pt_informed_consents.emergency_phone` | tel | O | — | max 20 | Consent (Snapshot) | none |
| Address snapshot | `pt_informed_consents.address` | textarea | O | — | max 1000 | Consent (Snapshot) | none |
| Occupation snapshot | `pt_informed_consents.occupation` | text | O | — | max 255 | Consent (Snapshot) | none |
| Acknowledgement: understands risk | `acknowledgements.understands_risk` | checkbox | R | — | must be true to complete | Consent | none |
| Acknowledgement: accurate medical history | `acknowledgements.accurate_medical_history` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: will inform pain | `acknowledgements.will_inform_pain` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: stop if dizzy | `acknowledgements.will_stop_if_dizzy` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: stop if chest pain | `acknowledgements.will_stop_if_chest_pain` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: communicate changes | `acknowledgements.will_communicate_changes` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: follow instructions | `acknowledgements.will_follow_instructions` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: confidentiality | `acknowledgements.understands_confidentiality` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: voluntary | `acknowledgements.voluntary_participation` | checkbox | R | — | must be true | Consent | none |
| Acknowledgement: final declaration | `acknowledgements.final_declaration` | checkbox | R | — | must be true | Consent | none |
| Exercise consent text | `exercise_consent_text` | server constant | R | — | max 8000 | Consent | none |
| Exercise consent accepted | `exercise_consent_checked` | checkbox | R | — | must be true to sign | Consent | none |
| Exercise consent date | `exercise_consent_date` | date | C | When accepted | within last 7 days, not future | Consent | none |
| Exercise consent signed at | `exercise_consent_signed_at` | timestamp | R | Set when checkbox + signature present | server `NOW()` | Consent | none |
| Exercise consent signature | `exercise_consent_signature` | signature | C | When accepted | data URL | Consent | none |
| Physician advised against | `physician_advised_against` | boolean | O | — | — | Consent | none |
| Physician name | `physician_name` | text | C | If advised against | max 255 | Consent | none |
| Hospital | `hospital` | text | C | If advised against | max 255 | Consent | none |
| Medical condition | `medical_condition` | text | C | If advised against | max 1000 | Consent | none |
| Medical clearance file | `medical_clearance_file_url` | upload | C | If advised against and no PAR-Q clearance | URL/path | Consent | none |
| Client signature | `client_signature` | signature | R for completion | — | data URL; one per role | Consent | none |
| Trainer signature | `trainer_signature` | signature | R for completion | — | data URL; one per role | Consent | none |
| Witness signature | `witness_signature` | signature | O | — | data URL; one per role | Consent | none |
| Witness name | `witness_name` | text | C | If witness signs | max 255 | Consent | none |
| Client signed at | `client_signed_at` | timestamp | C | On client sign | server | Consent | none |
| Trainer signed at | `trainer_signed_at` | timestamp | C | On trainer sign | server | Consent | none |
| Witness signed at | `witness_signed_at` | timestamp | C | On witness sign | server | Consent | none |
| IP address | `ip_address` | hidden | O | On completion | captured | Consent | none |
| Device / browser | `device`, `browser` | hidden | O | On completion | captured | Consent | none |
| Completed at | `completed_at` | timestamp | C | On completion | server | Consent | none |
| PDF URL | `pdf_url` | hidden | O | On completion | generated | Consent | none |
| Content version / hash | — | — | R | — | **does not exist** | Consent | additive |
| Revocation reason | activity log payload | textarea | C | On revoke | max 1000 | Consent | none |

---

## 3. PAR-Q / Health Screening

### 3.1 Snapshot

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Full name | `pt_parq_forms.full_name` | text | R | — | 1–255 | PAR-Q (Snapshot) | none |
| Gender | `pt_parq_forms.gender` | select | O | — | max 20 | PAR-Q (Snapshot) | none |
| DOB | `pt_parq_forms.dob` | date | O | — | date | PAR-Q (Snapshot) | none |
| Mobile | `pt_parq_forms.mobile` | tel | O | — | max 20 | PAR-Q (Snapshot) | none |
| Email | `pt_parq_forms.email` | email | O | — | email, max 255 | PAR-Q (Snapshot) | none |
| Emergency contact | `pt_parq_forms.emergency_contact` | text | O | — | max 255 | PAR-Q (Snapshot) | none |
| Emergency phone | `pt_parq_forms.emergency_phone` | tel | O | — | max 20 | PAR-Q (Snapshot) | none |
| Blood group | `pt_parq_forms.blood_group` | select | O | — | max 10 | PAR-Q | none |
| Height | `pt_parq_forms.height_cm` | number | O | — | numeric | PAR-Q (Snapshot) | none |
| Weight | `pt_parq_forms.weight_kg` | number | O | — | numeric | PAR-Q (Snapshot) | none |
| BMI | `pt_parq_forms.bmi` | number | Derived | — | currently accepts client value; computes only if absent | PAR-Q (Snapshot) | stop-write; always compute |
| Trainer name | `pt_parq_forms.trainer_name` | text | O | — | max 255 | PAR-Q | none |

### 3.2 Current health (`current_health` JSONB)

All optional unless stated; values are boolean + free text details unless noted.

| Field / data point | Keys | Input | Req | Current validation | Target owner |
|---|---|---|---|---|---|
| Known disease | `known_disease`, `known_disease_details` | boolean + text | O | JSONB free shape | PAR-Q |
| Activity level | `activity_level` | select | O | JSONB free shape | PAR-Q |
| Dietary habits | `dietary_habits` | text | O | JSONB | PAR-Q (medical context) |
| Water intake | `water_intake` | text | O | JSONB | **Nutrition** (stop accepting/writing in PAR-Q; render legacy only) |
| Caffeine | `caffeine`, `caffeine_details` | boolean + text | O | JSONB | PAR-Q |
| Alcohol | `alcohol`, `alcohol_details` | boolean + text | O | JSONB | **Lifestyle** (stop accepting/writing in PAR-Q; render legacy only) |
| Smoking | `smoking`, `smoking_details` | boolean + text | O | JSONB | **Lifestyle** (stop accepting/writing in PAR-Q) |
| Tobacco | `tobacco`, `tobacco_details` | boolean + text | O | JSONB | **Lifestyle** (stop accepting/writing in PAR-Q) |
| Nicotine | `nicotine`, `nicotine_details` | boolean + text | O | JSONB | **Lifestyle** (stop accepting/writing in PAR-Q) |
| Sleep hours | `sleep_hours` | number | O | JSONB | **Lifestyle** (stop accepting/writing in PAR-Q) |
| Medications | `medications`, `medications_details` | boolean + text | O | JSONB | PAR-Q |
| Supplements | `supplements`, `supplements_details` | boolean + text | O | JSONB | PAR-Q screening; Nutrition owns regimen detail |
| Steroids / PED | `steroids_ped`, `steroids_ped_details` | boolean + text | O | JSONB | PAR-Q |
| Recreational drugs | `recreational_drugs`, `recreational_drugs_details` | boolean + text | O | JSONB | PAR-Q |
| Current treatment | `current_treatment`, `current_treatment_details` | boolean + text | O | JSONB | PAR-Q |
| Pain present | `has_pain` | boolean | O | JSONB | PAR-Q |
| Pain scale | `pain_scale` | number | C | If pain | PAR-Q |
| Pain location | `pain_location` | text | C | If pain | PAR-Q |
| Pain description | `pain_description` | text | C | If pain | PAR-Q |

### 3.3 Past history (`past_history` JSONB)

All optional; boolean unless noted.

| Field / data point | Keys | Target owner |
|---|---|---|
| Heart disease | `heart_disease` | PAR-Q |
| Respiratory disease | `respiratory_disease` | PAR-Q |
| Asthma | `asthma` | PAR-Q |
| COPD | `copd` | PAR-Q |
| Tuberculosis | `tuberculosis` | PAR-Q |
| Joint problems | `joint_problems` | PAR-Q |
| Back pain | `back_pain` | PAR-Q |
| Neck pain | `neck_pain` | PAR-Q |
| Knee pain | `knee_pain` | PAR-Q |
| Shoulder pain | `shoulder_pain` | PAR-Q |
| Hip pain | `hip_pain` | PAR-Q |
| Previous fractures | `previous_fractures` | PAR-Q |
| Surgeries | `surgeries` | PAR-Q |
| Hospitalization | `hospitalization` | PAR-Q |
| Exercise history | `exercise_history` (text) | PAR-Q |
| Occupation | `occupation` (text) | **Lifestyle** (stop accepting/writing in PAR-Q; render legacy only) |
| Work posture | `work_posture` (text) | PAR-Q (medical context) |
| Daily sitting hours | `daily_sitting_hours` (number) | **Interview** (stop accepting/writing in PAR-Q; render legacy only) |
| Previous injuries | `previous_injuries` (text) | PAR-Q |
| Previous physiotherapy | `previous_physiotherapy` | PAR-Q |
| Previous trainer | `previous_trainer` | PAR-Q |
| Exercise experience | `exercise_experience` (text) | PAR-Q |

### 3.4 Family history (`pt_family_medical_history`)

| Field / data point | Column | Input | Req | Validation | Target owner |
|---|---|---|---|---|---|
| Relation | `relation` | select | R | father, mother, brother, sister, grandparent | PAR-Q |
| Heart disease | `heart_disease` | checkbox | O | boolean | PAR-Q |
| Diabetes | `diabetes` | checkbox | O | boolean | PAR-Q |
| Stroke | `stroke` | checkbox | O | boolean | PAR-Q |
| Hypertension | `hypertension` | checkbox | O | boolean | PAR-Q |
| Cancer | `cancer` | checkbox | O | boolean | PAR-Q |
| Hyperlipidemia | `hyperlipidemia` | checkbox | O | boolean | PAR-Q |
| Kidney disease | `kidney_disease` | checkbox | O | boolean | PAR-Q |
| Sudden death | `sudden_death` | checkbox | O | boolean | PAR-Q |
| Age of onset | `age_of_onset` | number | O | numeric | PAR-Q |
| Notes | `notes` | text | O | max 1000 | PAR-Q |

### 3.5 PAR-Q answers (`parq_answers` JSONB)

| Field / data point | Keys | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Question id | `question_id` | hidden | R | — | 1–10, unique per form | PAR-Q |
| Answer | `answer` | radio | R | Draft may be blank | yes, no, blank | PAR-Q |
| Explanation | `explanation` | textarea | C | If yes | max 1000 | PAR-Q |
| Diagnosis date | `diagnosis_date` | date | O | If yes | date | PAR-Q |
| Treatment | `treatment` | text | O | If yes | max 500 | PAR-Q |
| Doctor name | `doctor_name` | text | O | If yes | max 255 | PAR-Q |
| Hospital | `hospital` | text | O | If yes | max 255 | PAR-Q |
| Notes | `notes` | textarea | O | — | max 1000 | PAR-Q |

### 3.6 Trainer notes (`trainer_notes` JSONB)

| Field / data point | Keys | Input | Req | Validation | Target owner |
|---|---|---|---|---|---|
| Observations | `observations` | textarea | O | JSONB string | PAR-Q |
| Posture | `posture` | textarea | O | JSONB string | PAR-Q |
| Movement limitations | `movement_limitations` | textarea | O | JSONB string | PAR-Q |
| Recommendations | `recommendations` | textarea | O | JSONB string | PAR-Q |
| Contraindications | `contraindications` | textarea | O | JSONB string | PAR-Q |
| Precautions | `precautions` | textarea | O | JSONB string | PAR-Q |
| Summary | `summary` | textarea | O | JSONB string | PAR-Q |

### 3.7 Clearance, signature, and documents

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Doctor name | `pt_medical_clearances.doctor_name` | text | C | Approval | required to approve | PAR-Q | none |
| Hospital | `pt_medical_clearances.hospital` | text | O | — | max 255 | PAR-Q | none |
| Clearance date | `pt_medical_clearances.clearance_date` | date | C | Approval | required, not future | PAR-Q | none |
| Certificate URL | `pt_medical_clearances.certificate_url` | upload/link | C | Approval | required unless a document exists | PAR-Q | none |
| Doctor contact | `pt_medical_clearances.doctor_contact` | text | O | — | max 50 | PAR-Q | none |
| Expiry date | `pt_medical_clearances.expiry_date` | date | O | — | on/after clearance date | PAR-Q | none |
| Approval status | `pt_medical_clearances.approval_status` | select | R | — | approved, rejected, pending | PAR-Q | none |
| Reviewed by / at | `reviewed_by`, `reviewed_at` | hidden | O | Decision | server | PAR-Q | none |
| Restrictions | — | textarea | O | — | **does not exist** | PAR-Q | additive (optional) |
| PAR-Q attestation | `pt_consent_records.consent_checkboxes` | checkbox | R | Submit | `info_true` for new records | PAR-Q | none |
| Client signature | `pt_consent_records.client_signature` | signature | R | Submit | data URL | PAR-Q | none |
| Trainer signature | `pt_consent_records.trainer_signature` | signature | O | — | data URL | PAR-Q | none |
| Location | `pt_consent_records.location` | text | O | — | max 500 | PAR-Q | none |
| Document type | `pt_parq_documents.doc_type` | select | R | Upload | e.g. medical_certificate, medical_report | PAR-Q | none |
| Document file | `pt_parq_documents.file_url` | upload | R | Upload | file | PAR-Q | none |
| Risk level | `pt_parq_forms.risk_level` | Derived | R | — | low/medium/high, server-computed | PAR-Q | none |
| Workout gate | `pt_parq_forms.workout_gate_status` | Derived | R | — | blocked/cleared | PAR-Q | none |
| Form status | `pt_parq_forms.status` | select | R | — | draft/submitted/reviewed | PAR-Q | none |

---

## 4. Client Interview

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Training history | `pt_client_interviews.training_history` | textarea | O | — | max 2000 | Interview | none |
| Pain and injuries | `pt_client_interviews.pain_and_injuries` | textarea | O | — | max 2000 | Interview (current narrative) | none |
| Lifestyle | `pt_client_interviews.lifestyle` | textarea | O | — | max 2000 | Interview | none |
| Motivation | `pt_client_interviews.motivation` | textarea | O | — | max 2000 | Interview | none |
| Availability | `pt_client_interviews.availability` | textarea | O | — | max 1000 | Interview | none |
| Preferences | `pt_client_interviews.preferences` | textarea | O | — | max 1000 | Interview | none |
| Notes | `pt_client_interviews.notes` | textarea | O | — | max 2000 | Interview | none |
| Sitting hours | `lifestyle_sitting_hours` | select band → number | O | — | 0–24 numeric; UI stores midpoint | Interview | none |
| Meal regularity | `lifestyle_meal_regularity` | select | O | — | regular, irregular, inconsistent | Interview | none |
| Training days | `lifestyle_training_days` | select | O | — | 0–7 integer | Interview (availability) | none |
| Occupation | `lifestyle_occupation` | select | Legacy | — | enum; not written by UI | Lifestyle | deprecate |
| Screen time | `lifestyle_screen_time` | select | Legacy | — | enum; not written by UI | Lifestyle | deprecate |
| Sleep hours | `lifestyle_sleep_hours` | number | Legacy | — | 0–24; not written by UI | Lifestyle | deprecate |
| Smoking | `lifestyle_smoking` | select | Legacy | — | enum; not written by UI | Lifestyle | deprecate |
| Alcohol | `lifestyle_alcohol` | select | Legacy | — | enum; not written by UI | Lifestyle | deprecate |
| Interviewed by | `interviewed_by` | hidden | O | — | FK users | Interview | none |
| Status | `status` | select | R | — | draft/completed; completed requires an answer | Interview | none |
| Completed at | `completed_at` | timestamp | C | Completed | consistency CHECK with status | Interview | none |

---

## 5. Fitness Testing

### 5.1 Assessment metadata

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `pt_assessments.client_id` | hidden | R | — | FK `pt_clients` | Fitness Testing | none |
| Trainer | `pt_assessments.trainer_id` | hidden | O | — | from session; body value ignored | Fitness Testing | none |
| Assessment date | `assessment_date` | date | R | — | not future (one day slack) | Fitness Testing | none |
| Assessment type | `assessment_type` | select | O | — | initial, week_4, week_8, week_12, monthly, quarterly, follow_up, custom | Fitness Testing | none |
| Assessment number | `assessment_number` | derived | R | — | MAX+1 under advisory lock | Fitness Testing | none |
| Notes | `assessment_notes` | textarea | O | — | max 2000 | Fitness Testing | none |
| Testing conditions | `testing_conditions` | textarea | O | — | max 2000 | Fitness Testing | none |
| Trainer notes | `trainer_notes` | textarea | O | — | max 2000 | Fitness Testing | none |
| Age used | request fallback `age` | number | C | If no DOB | 5–110 | Fitness Testing | stop accepting for new clients |
| Gender used | request fallback `gender` | select | C | If no gender | Male/Female/Other | Fitness Testing | stop accepting for new clients |
| BP not measured | `bp_not_measured` | checkbox | C | Exertion test with no BP | boolean | Fitness Testing | none |

### 5.2 Blood pressure and vitals

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Systolic | `bp_systolic` | number | C | Unless acknowledged skip | 60–260 | Fitness Testing |
| Diastolic | `bp_diastolic` | number | C | Unless acknowledged skip | 30–160 | Fitness Testing |
| Resting heart rate | `resting_heart_rate` | number | O | — | 25–220 | Fitness Testing |
| Resting SpO₂ | `resting_spo2` | number | O | — | 50–100 | Fitness Testing |
| BP category | `bp_category` | derived | — | — | server | Fitness Testing |

### 5.3 Anthropometric

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Weight | `weight` | number | R for BMI | — | 20–350 | Fitness Testing |
| Height | `height_cm` | number | R for BMI | — | 80–250 | Fitness Testing |
| BMI | `bmi` | derived | — | — | server | Fitness Testing |
| Waist | `waist_cm` | number | O | — | 30–250 | Fitness Testing |
| Waist-iliac | `waist_iliac_cm` | number | O | — | 30–250 | Fitness Testing |
| Hips | `hips_cm` | number | O | — | 30–250 | Fitness Testing |
| WHR | `waist_hip_ratio` | derived | — | Waist and hips | server | Fitness Testing |
| Neck | `neck_cm` | number | O | — | 15–80 | Fitness Testing |
| Chest | `chest_cm` | number | O | — | 40–250 | Fitness Testing |
| Right arm | `arm_right_cm` | number | O | — | 10–100 | Fitness Testing |
| Left arm | `arm_left_cm` | number | O | — | 10–100 | Fitness Testing |
| Right thigh | `thigh_right_cm` | number | O | — | 20–150 | Fitness Testing |
| Left thigh | `thigh_left_cm` | number | O | — | 20–150 | Fitness Testing |
| Right calf | `calf_right_cm` | number | O | — | 15–100 | Fitness Testing |
| Left calf | `calf_left_cm` | number | O | — | 15–100 | Fitness Testing |
| Legacy arms | `arms_cm` | number | Legacy | — | none | Fitness Testing (read-only) |
| Legacy thighs | `thighs_cm` | number | Legacy | — | none | Fitness Testing (read-only) |

### 5.4 Body composition

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Method | `body_comp_method` | select | O | — | BIA Machine, Skinfold, DEXA, Manual, Other | Fitness Testing |
| Body fat % | `body_fat_pct` | number | O | — | 2–75 | Fitness Testing |
| Muscle mass % | `muscle_mass_pct` | number | O | — | 5–80 | Fitness Testing |
| Visceral fat | `visceral_fat` | number | O | — | 1–60 | Fitness Testing |
| Subcutaneous fat % | `subcutaneous_fat_pct` | number | O | — | 1–70 | Fitness Testing |
| Body water % | `body_water_pct` | number | O | — | 20–80 | Fitness Testing |
| Bone mass | `bone_mass_kg` | number | O | — | 0.5–10 | Fitness Testing |
| BMR | `bmr` | number | O | Auto-suggested from weight/height/age/gender | 500–5000 | Fitness Testing |
| BMR auto flag | `bmr_auto_suggested` | checkbox | O | — | boolean | Fitness Testing |
| Metabolic age | `metabolic_age` | number | O | — | 10–110 | Fitness Testing |
| Lean body mass | `lean_body_mass_kg` | derived | — | Weight and body fat | server | Fitness Testing |
| Fat mass | `fat_mass_kg` | derived | — | Weight and body fat | server | Fitness Testing |

### 5.5 Cardiorespiratory

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Test type | `cardio_test_type` | select | O | — | YMCA Step, Rockport, Cooper, Bruce, Harvard, Custom | Fitness Testing |
| Protocol data | `cardio_test_data` JSONB | mixed | C | Per test type | JSONB; flexible | Fitness Testing |
| VO₂ max | `vo2_max` | derived | — | Enough protocol data | server | Fitness Testing |
| Category | `cardio_category` | derived | — | — | server | Fitness Testing |
| Score | `cardio_score_computed` | derived | — | — | 0–100 server | Fitness Testing |

### 5.6 Muscular strength (test)

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Exercise 1 | `strength_exercise` | select/text | O | — | max 100 | Fitness Testing |
| Exercise 2 | `strength_exercise_2` | select/text | O | — | max 100 | Fitness Testing |
| Test payload | `strength_test_data` JSONB | mixed | C | Per lift | JSONB | Fitness Testing |
| Weight | `strength_logs.weight_kg` | number | C | Test recorded | > 0, max 1000 | Fitness Testing |
| Reps | `strength_logs.reps_done` | number | C | Estimated 1RM | 1–100 | Fitness Testing |
| Sets | `strength_logs.sets_done` | number | O | — | 1–50 | Fitness Testing |
| Formula | `strength_logs.one_rm_formula` | select | O | — | epley, brzycki | Fitness Testing |
| Direct 1RM | `strength_logs.is_direct_1rm` | checkbox | O | — | boolean | Fitness Testing |
| 1RM | `strength_logs.one_rm_estimate` | derived | C | Direct or estimated | server | Fitness Testing |
| Strength score | `strength_score_computed` | derived | — | — | 0–100 server | Fitness Testing |

### 5.7 Muscular endurance

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Test type 1 | `endurance_test_type` | select | O | — | Push Up, Curl Up, Wall Sit, Plank, Bodyweight Squat, Custom | Fitness Testing |
| Test type 2 | `endurance_test_type_2` | select | O | — | same | Fitness Testing |
| Test payload | `endurance_test_data` JSONB | mixed | C | Per test | reps or duration | Fitness Testing |
| Category | `endurance_category` | derived | — | — | server | Fitness Testing |
| Score | `endurance_score_computed` | derived | — | — | 0–100 server | Fitness Testing |

### 5.8 Flexibility / mobility battery

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Battery payload | `flexibility_test_data` JSONB | mixed | O | — | v3 K11 or legacy `{test1,test2}` | Fitness Testing |
| Sit-and-reach | `flexibility_test_data.sit_and_reach.inches` | number | O | — | 0–60 inches | Fitness Testing |
| Shoulder reach | `flexibility_test_data` | number | O | — | protocol-defined | Fitness Testing |
| Trunk rotation | `flexibility_test_data` | number | O | — | protocol-defined | Fitness Testing |
| Ankle mobility | `flexibility_test_data.distance_cm` | number | O | — | 0–60 cm | Fitness Testing |
| Asymmetry | `has_asymmetry` | derived | — | Left/right difference | 10% threshold | Fitness Testing |
| Category | `flexibility_category` | derived | — | — | server | Fitness Testing |
| Score | `mobility_score_computed` | derived | — | — | 0–100 server | Fitness Testing |

### 5.9 Overall and history

| Field / data point | Current location | Input | Req | Conditional | Validation | Target owner |
|---|---|---|---|---|---|---|
| Body composition score | `body_composition_score` | derived | — | — | 0–100 | Fitness Testing |
| Health risk score | `health_risk_score` | derived | — | — | 0–100 | Fitness Testing |
| Overall score | `overall_fitness_score` | derived | — | — | 0–100 | Fitness Testing |
| Posture notes | `posture_notes` | textarea | O | — | max 2000 | Fitness Testing (legacy; Posture owns current) |
| Health notes | `health_notes` | textarea | O | — | max 2000 | Fitness Testing |
| Scoring version | — | — | O | — | **does not exist** | Fitness Testing | additive |

---

## 6. Goal Assessment

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `pt_goals.client_id` | hidden | R | — | FK | Goal | none |
| Goal type | `goal_type` | select | R | — | 14-value enum | Goal | none |
| Custom goal name | `goal_other` | text | C | `goal_type = custom` | max 200 | Goal | none |
| Goal statement | `goal_description` | textarea | O | — | max 2000 | Goal | none |
| Target weight | `target_weight` | number | C | Weight goal | 25–300 | Goal | none |
| Target body fat | `target_body_fat` | number | C | Body-fat goal | 3–60 | Goal | none |
| Target metric (K11) | `routine_blueprint.k11.measure.metric` | select | C | Non-weight/body-fat goal | sanitized server-side | Goal | none |
| Target exercise | `routine_blueprint.k11.measure.exercise` | text | C | Strength goal | sanitized | Goal | none |
| Target start | `routine_blueprint.k11.measure.start` | number | C | — | sanitized | Goal | none |
| Target value | `routine_blueprint.k11.measure.target` | number | C | — | sanitized | Goal | none |
| Custom metric | `routine_blueprint.k11.measure.custom` | text | C | Custom metric | sanitized | Goal | none |
| Target date | `target_date` | date | O | — | today or later | Goal | none |
| Priority | `priority_goal` | text | O | — | max 50 | Goal | none |
| Motivation reason | `motivation_reason` | textarea | O | — | max 2000 | Goal | none |
| Motivation level | `motivation_level` | number | O | — | 1–10 | Goal | none |
| Commitment level | `commitment_level` | number | O | — | 1–10 | Goal | none |
| Confidence level | `routine_blueprint.coaching.confidence_level` | number | O | — | 1–10 | Goal | none |
| Biggest challenges | `biggest_challenges` | multi-select | O | — | max 20, item max 200 | Goal | none |
| Barrier plans | `routine_blueprint.coaching.barrier_plans` | structured | O | Per challenge | JSONB | Goal | none |
| Readiness: meal prep | `lifestyle_readiness.meal_prep_possible` | yes/no | O | — | boolean | Goal | none |
| Readiness: water | `lifestyle_readiness.drink_enough_water` | yes/no | O | — | boolean | Goal | none |
| Readiness: family support | `lifestyle_readiness.family_support` | yes/no | O | — | boolean | Goal | none |
| Readiness: medical restrictions | `lifestyle_readiness.medical_restrictions` | yes/no | O | — | boolean; feeds risk factors | Goal | none |
| Readiness: consistent schedule | `lifestyle_readiness.consistent_schedule` | yes/no | O | — | boolean | Goal | none |
| Readiness: regular training time | `lifestyle_readiness.regular_training_time` | yes/no | O | — | boolean | Goal | none |
| Readiness: stress managed | `lifestyle_readiness.stress_managed` | yes/no | O | — | boolean | Goal | none |
| Readiness: willing to track | `lifestyle_readiness.willing_to_track` | yes/no | O | — | boolean | Goal | none |
| Readiness score | `lifestyle_readiness_score` | derived | — | — | 0–100 server | Goal | none |
| Starting weight | `starting_weight` | number | C | Snapshot | 25–350; manual or latest test | Goal (Snapshot) | none |
| Starting body fat | `starting_body_fat_pct` | number | C | Snapshot | 2–75 | Goal (Snapshot) | none |
| Programmed training days | `training_days_per_week` | number | O | — | 1–7 | Goal | none |
| Preferred days | `preferred_training_days` | multi-select | O | — | 7 weekdays | Goal | none |
| Training split | `training_split` | text | O | — | max 100 | Goal | none |
| Session length | `routine_blueprint.coaching.session_minutes` | number | O | — | positive | Goal | none |
| Time of day | `routine_blueprint.coaching.time_of_day` | select | O | — | enum | Goal | none |
| Success metric | `routine_blueprint.coaching.success_metric` | text | O | — | text | Goal | none |
| Experience level | `routine_blueprint` / prefill from client | select | O | — | beginner/intermediate/advanced | Add Client (display) | stop-write |
| Equipment | `routine_blueprint` | multi-select | O | — | list | Goal | none |
| Milestones | `milestones` JSONB | structured | O | — | JSONB | Goal | none |
| Short-term weeks | `short_term_weeks` | number | O | — | 1–52 | Goal | none |
| Medium-term weeks | `medium_term_weeks` | number | O | — | 1–52 | Goal | none |
| Review date | `review_date` | date | O | — | today or later | Goal | none |
| Notes | `notes` | textarea | O | — | max 2000 | Goal | none |
| Status | `status` | select | O | — | active, paused, completed, archived | Goal | none |
| Difficulty | `goal_difficulty` | derived | — | — | server | Goal | none |
| Estimated weeks | `estimated_duration_weeks` | derived | — | — | server | Goal | none |
| Recommended PT months | `recommended_pt_duration_months` | derived | — | — | server | Goal | none |
| Required weekly rate | `estimated_weekly_rate_kg` | derived | — | — | server | Goal | none |
| Safe weekly rate | `safe_weekly_rate_kg` | derived | — | — | server | Goal | none |
| Risk factors | `risk_factors` | derived | — | — | server | Goal | none |

---

## 7. Lifestyle Assessment

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `pt_lifestyle_assessments.client_id` | hidden | R | — | FK | Lifestyle | none |
| Assessment date | `assessment_date` | date | R | — | not future | Lifestyle | none |
| Assessment number | `assessment_number` | derived | O | — | per-client sequence | Lifestyle | none |
| Sleep duration | `sleep_duration_hours` | number | O | — | 0–16 | Lifestyle | none |
| Bed time | `bed_time` | time | O | — | time | Lifestyle | none |
| Wake time | `wake_time` | time | O | — | time | Lifestyle | none |
| Sleep quality | `sleep_quality` | number | O | — | 1–10 | Lifestyle | none |
| Stress level | `stress_level` | number | O | — | 1–10 | Lifestyle | none |
| Water intake | `water_intake_liters` | number | Legacy | — | 0–10 | Nutrition | deprecate |
| Occupation | `occupation_type` | select | O | — | 11-value enum | Lifestyle | none |
| Daily steps | `daily_steps_bracket` | select | O | — | 5 bands | Lifestyle | none |
| Workout experience | `workout_experience_level` | select | O | — | beginner/intermediate/advanced/athlete | Add Client (display) | stop-write |
| Years of experience | `years_of_experience` | number | O | — | 0–80 | Lifestyle | none |
| Food preferences | `food_preferences` | multi-select | Legacy | — | max 20 | Nutrition | deprecate |
| Meal frequency | `meal_frequency` | number | Legacy | — | 1–10 | Nutrition | deprecate |
| Breakfast habit | `breakfast_habit` | select | Legacy | — | daily/sometimes/never | Nutrition | deprecate |
| Late-night eating | `late_night_eating` | boolean | Legacy | — | boolean | Nutrition | deprecate |
| Smoking status | `smoking_status` | select | O | — | never/occasionally/daily/former | Lifestyle | none |
| Cigarettes per day | `cigarettes_per_day` | number | C | Smoker | 0–100; cleared when never | Lifestyle | none |
| Years smoking | `years_smoking` | number | C | Smoker | 0–80; cleared when never | Lifestyle | none |
| Alcohol status | `alcohol_status` | select | O | — | never/occasionally/weekly/frequently | Lifestyle | none |
| Drinks per week | `drinks_per_week` | number | C | Drinks alcohol | 0–100; cleared when never | Lifestyle | none |
| Screen time | `screen_time_bracket` | select | O | — | 5 bands | Lifestyle | none |
| Travel frequency | `travel_frequency` | select | O | — | rarely/monthly/weekly/daily | Lifestyle | none |
| Energy level | `energy_level` | number | O | — | 1–10 | Lifestyle | none |
| Motivation to exercise | `motivation_to_exercise` | number | Legacy | — | 1–10; API-only, not asked by the wizard | Goal | deprecate; stop-write |
| Recovery quality | `recovery_quality` | select | O | — | poor/average/good/excellent | Lifestyle | none |
| Coach notes | `coach_notes` JSONB | textarea map | O | — | key max 60, value max 2000 | Lifestyle | none |
| Sleep score | `sleep_score` | derived | — | — | server | Lifestyle | none |
| Stress score | `stress_score` | derived | — | — | server | Lifestyle | none |
| Hydration score | `hydration_score` | derived | — | — | server | Lifestyle | none |
| Activity score | `activity_score` | derived | — | — | server | Lifestyle | none |
| Nutrition score | `nutrition_score` | derived | — | — | server | Lifestyle | none |
| Recovery score | `recovery_score` | derived | — | — | server | Lifestyle | none |
| Lifestyle score | `lifestyle_score` | derived | — | — | 0–100 server | Lifestyle | none |
| Habit risk score | `habit_risk_score` | derived | — | — | server | Lifestyle | none |
| Sedentary risk | `sedentary_risk` | derived | — | — | server | Lifestyle | none |
| Recovery risk | `recovery_risk` | derived | — | — | server | Lifestyle | none |
| Lifestyle readiness | `lifestyle_readiness` | derived | — | — | server | Lifestyle | none |
| Risk factors | `risk_factors` | derived | — | — | server | Lifestyle | none |

---

## 8. Nutrition Assessment

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `pt_nutrition_assessments.client_id` | hidden | R | — | FK | Nutrition | none |
| Assessment date | `assessment_date` | date | R | — | not future | Nutrition | none |
| Assessment number | `assessment_number` | derived | O | — | per-client sequence | Nutrition | none |
| Diet preferences | `diet_preferences` | multi-select | O | — | max 20, item max 60 | Nutrition | none |
| Food allergies | `food_allergies` | multi-select | O | — | max 30, item max 100 | Nutrition | none |
| Foods to avoid | `foods_to_avoid` | multi-select | O | — | max 30, item max 100 | Nutrition | none |
| Avoid reason | `foods_to_avoid_reason` | select | C | Foods to avoid | medical/religious/personal_preference/taste/digestive_issue | Nutrition | none |
| Favourite foods | `favourite_foods` | multi-select | O | — | max 30, item max 100 | Nutrition | none |
| Takes supplements | `takes_supplements` | boolean | O | — | boolean | Nutrition | none |
| Supplement list | `supplements` JSONB | structured | C | Takes supplements | name 1–100, dose/frequency/brand ≤100, max 30 | Nutrition | none |
| Digestive issues | `digestive_issues` JSONB | structured | O | — | issue ≤100, frequency daily/weekly/rare, severity 1–10, max 20 | Nutrition | none |
| Meals per day | `meals_per_day` | number | O | — | 1–10 | Nutrition | none |
| Breakfast regularity | `breakfast_regularity` | select | O | — | daily/sometimes/never | Nutrition | none |
| Lunch regularity | `lunch_regularity` | select | O | — | daily/sometimes/never | Nutrition | none |
| Dinner regularity | `dinner_regularity` | select | O | — | daily/sometimes/never | Nutrition | none |
| Snacks per day | `snacks_per_day` | number | O | — | 0–15 | Nutrition | none |
| Late-night eating | `late_night_eating` | boolean | O | — | boolean | Nutrition | none |
| Meal timing consistency | `meal_timing_consistency` | select (still asked) | O | — | consistent/somewhat_consistent/inconsistent | Interview (quick screen) | stop-write; remove from form |
| Eating out frequency | `eating_out_frequency` | select | O | — | rarely/weekly/frequently/daily | Nutrition | none |
| Weekend eating habits | `weekend_eating_habits` | select | O | — | 3 values | Nutrition | none |
| Eating behaviours | `eating_behaviours` | multi-select | O | — | max 30, item max 100 | Nutrition | none |
| Water intake | `water_intake_liters` | number | O | — | 0–10 | Nutrition | none |
| Tea cups | `tea_cups_per_day` | number | O | — | 0–30 | Nutrition | none |
| Coffee cups | `coffee_cups_per_day` | number | O | — | 0–30 | Nutrition | none |
| Soft drinks | `soft_drinks_per_day` | number | O | — | 0–30 | Nutrition | none |
| Juices | `juices_per_day` | number | O | — | 0–30 | Nutrition | none |
| Alcoholic drinks | `alcoholic_drinks_per_week` | number | Legacy | — | 0–100; API-only, not asked by the wizard | Lifestyle | deprecate |
| Daily fluid intake | `daily_fluid_intake_liters` | derived | — | — | server | Nutrition | none |
| Cravings | `cravings` | multi-select | O | — | max 30, item max 100 | Nutrition | none |
| Craving frequency | `craving_frequency` | select | O | — | rare/sometimes/daily | Nutrition | none |
| Meal preparer | `meal_preparer` | select | O | — | 8 values | Nutrition | none |
| Nutrition budget | `nutrition_budget` | select | O | — | low/medium/high/premium | Nutrition | none |
| Medical conditions | `medical_conditions` | multi-select (still asked) | O | — | max 30, item max 100 | PAR-Q | stop-write; replace with read-only PAR-Q summary |
| Medical notes | `medical_notes` | textarea | O | — | max 2000 | Nutrition | none |
| Coach notes | `coach_notes` JSONB | textarea map | O | — | string map | Nutrition | none |
| Diet quality score | `diet_quality_score` | derived | — | — | server | Nutrition | none |
| Protein score | `protein_score` | derived | — | — | server | Nutrition | none |
| Protein assessment | `protein_assessment` | derived | — | — | server | Nutrition | none |
| Hydration score | `hydration_score` | derived | — | — | server | Nutrition | none |
| Digestive score | `digestive_health_score` | derived | — | — | server | Nutrition | none |
| Supplement score | `supplement_score` | derived | — | — | server | Nutrition | none |
| Nutrition risk | `nutrition_risk_score` | derived | — | — | server | Nutrition | none |
| Nutrition score | `nutrition_score` | derived | — | — | 0–100 server | Nutrition | none |
| Nutrition readiness | `nutrition_readiness` | derived | — | — | server | Nutrition | none |
| Risk factors | `risk_factors` | derived | — | — | server | Nutrition | none |
| TDEE | — | — | O | If approved | **does not exist** | Nutrition | additive (if approved) |
| Calorie target | — | — | O | If approved | **does not exist**; diet plans hold `daily_calories` | Nutrition / diet plan | additive (if approved) |
| Macro targets | — | — | O | If approved | **do not exist**; diet plans hold protein/carbs/fats | Nutrition / diet plan | additive (if approved) |

---

## 9. Mobility & Performance

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `pt_mobility_performance_assessments.client_id` | hidden | R | — | FK | Mobility | none |
| Assessment date | `assessment_date` | date | R | — | not future | Mobility | none |
| Assessment number | `assessment_number` | derived | O | — | per-client sequence | Mobility | none |
| Body regions | `body_regions` JSONB | structured | O | — | max 20; region ≤60; score 1–5; pain/restriction boolean | Mobility | none |
| Functional tests | `mobility_tests` JSONB | structured | O | — | max 20; test ≤60; score 1–5; notes ≤500 | Mobility | none |
| Grip strength | `grip_strength_kg` | number | O | — | 1–150 | Mobility | none |
| Vertical jump | `vertical_jump_cm` | number | O | — | 1–150 | Mobility | none |
| Sit-and-reach | `sit_reach_cm` | number | Legacy | — | −50–80 cm | Fitness Testing (inches) | deprecate |
| Balance | `balance_test_seconds` | number | O | — | 0–600 | Mobility | none |
| Reaction time | `reaction_time_ms` | number | O | — | 50–3000 | Mobility | none |
| Performance notes | `performance_notes` | textarea | O | — | max 2000 | Mobility | none |
| Mobility score | `mobility_score` | derived | — | — | 0–100 server | Mobility | none |
| Category | `mobility_category` | derived | — | — | server, pain/restriction cap | Mobility | none |
| Referrals | derived on read | — | — | If pain | text list | Mobility | none |

---

## 10. Posture Assessment

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `pt_posture_assessments.client_id` | hidden | R | — | FK | Posture | none |
| Assessment date | `assessment_date` | date | R | — | not future | Posture | none |
| Assessment number | `assessment_number` | derived | O | — | per-client sequence | Posture | none |
| Front issues | `front_issues` | multi-select | O | — | max 20, item max 60 | Posture | none |
| Side issues | `side_issues` | multi-select | O | — | max 20, item max 60 | Posture | none |
| Back issues | `back_issues` | multi-select | O | — | max 20, item max 60 | Posture | none |
| Other notes | `other_issue_notes` | textarea | O | — | max 1000 | Posture | none |
| Coach notes | `coach_notes` JSONB | textarea map | O | — | string map | Posture | none |
| Risk score | `posture_risk_score` | derived | — | — | 0–100 server | Posture | none |
| Risk level | `posture_risk_level` | derived | — | — | Low/Moderate/High | Posture | none |
| Referrals | derived on read | — | — | Scoliosis | text list | Posture | none |

---

## 11. Strength Tracking

| Field / data point | Current location | Input | Req | Conditional | Current validation | Target owner | Migration impact |
|---|---|---|---|---|---|---|---|
| Client | `strength_logs.client_id` | hidden | R | — | FK | Strength Tracking | none |
| Exercise | `exercise_name` | select/text | R | — | 1–100 | Strength Tracking | none |
| Weight | `weight_kg` | number | R | — | > 0, max 1000 | Strength Tracking | none |
| Sets | `sets_done` | number | O | — | 1–50 | Strength Tracking | none |
| Reps | `reps_done` | number | C | Unless direct 1RM | 1–100 | Strength Tracking | none |
| Notes | `notes` | textarea | O | — | max 1000 | Strength Tracking | none |
| Assessment link | `assessment_id` | hidden | O | Test projection | must belong to the client | Fitness Testing when set | none |
| Formula | `one_rm_formula` | select | O | — | epley/brzycki | Strength Tracking | none |
| Direct 1RM | `is_direct_1rm` | checkbox | O | — | boolean | Strength Tracking | none |
| 1RM estimate | `one_rm_estimate` | derived | C | — | > 0, max 1000; server-computed | Strength Tracking | none |
| Log date | `log_date` | date | O | — | not future; studio today default | Strength Tracking | none |

---

## 12. Derived-field register

| Derived value | Inputs | Stored at | Formula / source | Trust rule |
|---|---|---|---|---|
| BMI | weight, height | `pt_assessments.bmi`; `pt_parq_forms.bmi` | kg / m² | Fitness Testing recomputes; PAR-Q must recompute |
| Waist-to-hip ratio | waist, hips | `pt_assessments.waist_hip_ratio` | waist / hips | server |
| BMR | weight, height, age, gender | `pt_assessments.bmr` | Mifflin-St Jeor: `10w + 6.25h − 5a + 5` male, `−161` otherwise | server; manual override allowed |
| Lean body mass | weight, body fat | `pt_assessments.lean_body_mass_kg` | `w × (1 − bf/100)` | server |
| Fat mass | weight, body fat | `pt_assessments.fat_mass_kg` | `w × bf/100` | server |
| VO₂ max | protocol data | `pt_assessments.vo2_max` | Rockport, Cooper, Bruce, Harvard | server |
| Category scores | test data + norms | `*_category`, `*_score_computed` | `fitness-scoring.js` | server |
| Overall score | category scores | `overall_fitness_score` | weighted score function | server |
| 1RM | weight, reps, formula | `strength_logs.one_rm_estimate` | Epley, Brzycki | server; direct 1RM only client value |
| Goal required rate | start, target, days | `estimated_weekly_rate_kg` | `(target − start) / weeks` | server |
| Goal safe rate | metric, current | `safe_weekly_rate_kg` | `goal-scoring.js` | server |
| Goal duration | start, target, safe rate | `estimated_duration_weeks` | `goal-scoring.js` | server |
| Goal difficulty | rate, safe rate, readiness, motivation | `goal_difficulty` | `goal-scoring.js` | server |
| Lifestyle scores | lifestyle answers | `pt_lifestyle_assessments.*` | `lifestyle-scoring.js` | server |
| Nutrition scores | nutrition answers + lifestyle alcohol | `pt_nutrition_assessments.*` | `nutrition-scoring.js` | server |
| Mobility score | 1–5 screen scores, pain, restriction | `mobility_score`, `mobility_category` | `mobility-scoring.js` | server |
| Posture risk | issue sets | `posture_risk_score`, `posture_risk_level` | `posture-scoring.js` | server |
| Referrals | pain/scoliosis flags | not stored | `*-scoring.js` | derived on read |

---

## 13. Duplicate register and resolution

| # | Duplicate data point | Copies | Resolution | Backward compatibility |
|---|---|---|---|---|
| D1 | Client identity at signing | `pt_clients`, `pt_parq_forms`, `pt_informed_consents` | Keep as deliberate snapshots. Consent/PAR-Q copy at creation only; never refresh. | No data change |
| D2 | Emergency contact/phone | `pt_clients`, `pt_parq_forms`, `pt_informed_consents` | Same as D1. | No data change |
| D3 | Height/weight/BMI | `pt_assessments`, `pt_clients`, `pt_parq_forms`, `pt_goals.starting_*` | Fitness Testing owns live measurements; `pt_clients` is a cache; PAR-Q/Goal are snapshots. Fix cache update rule. | Read fallbacks preserved |
| D4 | Goal | `pt_goals`, `pt_clients.goal` | Goal Assessment owns; `pt_clients.goal` is legacy fallback. | Keep column |
| D5 | Health conditions | `pt_clients.health_conditions`, `pt_parq_forms.current_health`, `pt_nutrition_assessments.medical_conditions` | PAR-Q owns; others stop writing, read fallback. | Keep columns |
| D6 | Injuries | `pt_clients.injuries`, `pt_parq_forms.past_history.previous_injuries`, `pt_client_interviews.pain_and_injuries` | PAR-Q owns medical history; Interview owns current narrative; `pt_clients` legacy. | Keep columns |
| D7 | Workout experience | `pt_clients.workout_experience_level`, `pt_lifestyle_assessments.workout_experience_level` | Add Client/enrolment owns; Lifestyle displays. | Keep column |
| D8 | Occupation | `pt_lifestyle_assessments.occupation_type`, `pt_client_interviews.lifestyle_occupation`, `pt_parq_forms.past_history.occupation`, `pt_clients.occupation`, consent snapshot | Lifestyle owns; Add Client/Interview/PAR-Q stop writing; consent snapshot stays. | Old values readable |
| D9 | Screen time | Lifestyle, Interview | Lifestyle owns; Interview stops writing. | Old values readable |
| D10 | Sleep hours | Lifestyle, Interview, PAR-Q | Lifestyle owns; others stop writing. | Old values readable |
| D11 | Smoking | Lifestyle, Interview, PAR-Q | Lifestyle owns; others stop writing. | Old values readable |
| D12 | Alcohol | Lifestyle, Interview, PAR-Q, Nutrition | Lifestyle owns; Nutrition stays fallback; others stop writing. | `resolveAlcohol` unchanged |
| D13 | Water intake | Nutrition, Lifestyle, PAR-Q | Nutrition owns; Lifestyle reads; PAR-Q stops writing. | `resolveNutritionHabits` unchanged |
| D14 | Meal frequency/breakfast/late-night | Nutrition, Lifestyle | Nutrition owns; Lifestyle reads. | Existing resolver |
| D15 | Meal regularity | Interview, Nutrition `meal_timing_consistency` | Interview owns the quick screen; Nutrition retires the duplicate field. | Old Nutrition values readable |
| D16 | Food preferences | Nutrition `diet_preferences`, Lifestyle `food_preferences` | Nutrition owns; Lifestyle stops writing. | Old values readable |
| D17 | Training days | Interview availability, Goal programmed days, `pt_clients.sessions_per_week` | Different facts: Interview availability, Goal prescription, client row enrolment fallback. | `client-facts` precedence unchanged |
| D18 | Sit-and-reach | Fitness flexibility (inches, scored), Mobility `sit_reach_cm` (cm, unscored) | Fitness owns; Mobility retires field. | Old mobility values readable |
| D19 | 1RM | Fitness strength test, Strength Tracking | One `calc1RM`; row ownership by `assessment_id`. | Guard already exists |
| D20 | PAR-Q consent vs informed consent | `pt_consent_records` (7 historical keys, 1 new), `pt_informed_consents` (10 keys) | PAR-Q attests answers; Consent owns legal attestations. Keep history. | Old PDFs render |
| D21 | Medical clearance | PAR-Q clearance, Consent clearance upload | Two distinct gates: PAR-Q high risk; physician advised against. Show both in the client snapshot. | No change |
| D22 | Workout experience in programming | `pt_clients`, `client_fitness_profiles`, Lifestyle | `client-facts` already reports precedence; keep. | No change |
| D23 | Medical conditions in Nutrition | PAR-Q, Nutrition | PAR-Q owns; Nutrition reads and keeps notes only. | Old values readable |
| D24 | `pt_clients.occupation` | Add Client, Lifestyle, Interview, PAR-Q, consent snapshot | Lifestyle owns; Add Client/Interview/PAR-Q stop writing; client column is a legacy fallback. | Old values readable |
| D25 | Motivation to exercise | Goal `motivation_level`, Lifestyle `motivation_to_exercise` | Goal owns the 1–10 motivation score and its reason; Lifestyle stops writing. | Old values readable |

---

## 14. Mandatory / optional / conditional summary

| Module | Required to complete | Optional | Conditional |
|---|---|---|---|
| Add Client | name, gender, mobile (UI); backend name | dob, WhatsApp, email, address, source, emergency | emergency relationship if contact/phone present |
| Informed Consent | full name, 10 acknowledgements, exercise consent, client + trainer signatures | witness signature/name, physician block | physician fields if advised against; clearance if advised against and no PAR-Q clearance |
| PAR-Q | full name, all 10 answers for submitted status | blood group, family history, trainer notes, clearance | clearance fields on approval; details on yes |
| Interview | at least one answer for completed status | all fields | — |
| Fitness Testing | client, date; BP unless acknowledged skip for exertion | most measurements | exertion tests need BP or skip; strength needs weight/reps unless direct |
| Goal | goal type | most fields | target weight/body fat by goal type; K11 measure for non-weight goals |
| Lifestyle | client, date | all answers | cigarette/years if smoker; drinks if alcohol |
| Nutrition | client, date | all answers | reason if foods to avoid; supplement list if takes supplements |
| Mobility | client, date | all answers | — |
| Posture | client, date | all answers | — |
| Strength Tracking | client, exercise, weight; reps unless direct 1RM | sets, notes, date | assessment link must belong to client |

---

## 15. Migration impact summary

| Impact class | Fields | Notes |
|---|---|---|
| No schema change | Most fields | Ownership changes are allow-list/write-path changes |
| Stop-write only | Duplicate fields in Interview, Lifestyle, Nutrition, PAR-Q, Add Client | Keep columns and read fallbacks |
| Additive column | Consent content version/hash; assessment scoring version; optional clearance restrictions; optional Nutrition TDEE/macros | Nullable, no backfill required |
| Backfill | None required for ownership | Optional later cleanup: populate legacy fallbacks only where the owner is null |
| Index/constraint | Existing indexes are sufficient | If assessment soft-delete is adopted, add `deleted_at` and partial indexes |

No field rename and no column drop is proposed in the first release. This keeps every historical row readable and every existing API consumer working.

---

## 16. Enforced behaviour (Phase 4 verification, Phase 5 reconciliation)

Verified 2026-11-03 against `phase4_shape`: a synthetic production-shaped fixture restored from the real schema and seeded with 540 clients in two studios, 722 assessments, 243 goals, 1,458 check-ins, 270 fitness profiles, 162 legacy measurement rows, and 14 soft-deleted clients. It reproduces the shapes the rules must survive, but it is **not production data**. The real-production criterion remains BLOCKED in the Phase 4 report.

The read-only D1–D25 audit on that fixture found 4,149 register rows where the owner holds a value, 981 legacy-only, 628 conflicting, and 53 stale beyond the one-year threshold. No audited check failed. The legacy-only and conflicting counts are the condition the precedence rules exist to report, not corruption.

| Rule | Behaviour now enforced | Evidence |
|---|---|---|
| D3 body (height/weight/BMI) | Latest `pt_assessments` row by `assessment_date DESC, created_at DESC`; a test typed months late cannot out-rank a newer test; the `pt_clients` cache follows the same rule and never moves backwards on a backdated insert | `productionShape.phase4.realDb.integration.test.js` (content-date, cache, and delete/fallback cases) |
| D3 consumer reads | Member weight goals, Transformations, the training brief, snapshot, coach card, and AI loader all read `pt_assessments`; `pt_os_measurements` is a logged legacy fallback only | Phase 4 suite; `weightSeries` and `getTransformations` cases |
| D4/D22 goal | Active `pt_goals` wins; `client_fitness_profiles.goal` and `pt_clients.goal` are reported as conflicts in precedence order | goal precedence and disputed-value cases |
| D5/D6/D23 medical | PAR-Q owns answered medical history; a draft PAR-Q answers nothing; legacy arrays remain readable fallbacks | draft-PAR-Q case and `resolveMedicalConditions` |
| D13–D16 nutrition/lifestyle | Nutrition and Lifestyle own their facts; duplicates are stop-write and read-only fallbacks | write-path suites from Phases 1–2 |
| D18 sit-and-reach | Fitness flexibility owns; Mobility `sit_reach_cm` is legacy-readable only | Mobility/Fitness suites |
| D19 1RM | One `calc1RM`; strength rows are owned through `assessment_id` | Strength Tracking suites |
| D20/D21 consent and clearance | PAR-Q attests answers; Consent owns legal attestation and physician clearance; both safety gates are visible together | both-safety-gates case |
| Tenant boundary | Every consumer returns nothing for a foreign or soft-deleted client; RLS is enabled and policied on all 15 tables the architecture reads; `app_tenant` cannot bypass RLS | tenant-isolation case; `rls.isolation.integration.test.js` (26 tests) |
| Deletion and recovery | Soft-deleted clients disappear from every read path while child history is retained; restore makes it readable again; assessment hard delete falls back to the previous test and re-syncs the cache; a `client.delete` audit row exists | deletion/recovery cases |
| AI provenance | Stale, disputed, draft-only, and missing facts reach the prompt labelled; values are never averaged or invented | provenance/stale/disputed/missing cases |
| Consumer surface | Frontend reads HTTP endpoints only; WhatsApp gateway has no database access; AI and coach consumers route through `loadClientSources` / `client-read.service` | consumer audit in the Phase 4 report |

### Phase 5 field-level reconciliation

Phase 5 opened the same fixture in one `REPEATABLE READ` read-only snapshot and produced a per-record report for every legacy-only and conflicting row, with both values, both record ids and both timestamps. Its counts validate against the Phase 4 aggregate above (981 legacy-only, 628 conflicts, 1,609 records).

Only 27 records are eligible for a reviewed backfill: D25 `pt_goals.motivation_level` where the active goal row exists, the field is `NULL`, and exactly one Lifestyle source supplies the value. Every conflict is report-only. The guarded apply script defaults to dry-run, requires the plan's SHA-256 and a named reviewer, allowlists seven columns, re-reads the owner row inside the transaction, aborts if the field is no longer `NULL`, and writes one `audit_log` row per change. None of the 27 candidates has been applied.

`/api/me/measurements` now reads canonical `pt_assessments` first (`source: 'assessment'`), keeps `pt_os_measurements` as a labelled trainer fallback, and includes member check-ins (`source: 'checkin'`). The frontend ranks assessment above trainer above check-in for a same-day point. The Phase 4 production-shape suite and this reconciliation report run as mandatory, non-skipping CI steps. Full evidence is in `PHASE5-LEGACY-RECONCILIATION-REPORT.md`.

### Known limits

- The canonical loader orders by `assessment_date DESC, created_at DESC`; the cache writer and progress list add `id DESC`. The two differ only when two rows share the same date *and* timestamp, which the fixture does not produce. Reported as a residual risk, not a live bug.
- `pt_os_measurements` has no `organization_id` and no writer. It is reachable only through the `pt_clients` join. The member `/api/me/measurements` route reads it as a labelled legacy source after canonical assessments.
- Four duplicate columns remain text arrays (`food_preferences`, `diet_preferences`, `medical_conditions`, `health_conditions`); this phase changed no schema.
- `pt_clients.weight`/`height` are still a cache that legacy readers may fall back to when no assessment exists.

### Schema-removal readiness

**No column drop is ready — NO-GO after Phase 5.** On the fixture, 981 duplicate-register rows exist only in legacy copies and 628 owner/legacy pairs disagree. Dropping those columns today would erase real facts for studios that never wrote the owner. The gate for any future contract step is: a production audit showing zero legacy-only facts (or a reviewed, reversible backfill applied through `phase5-apply-reconciliation.js`), all readers confirmed on the canonical owner for one release, and retirement of the member measurements legacy fallback. This phase authorises no drop, rename, or destructive migration.

## 17. Ownership enforcement (Phase 6)

Phase 6 adds the enforcement layer the earlier phases lacked: a guarded
production audit, a decision register a named reviewer must fill, and a CI
guard that makes a new legacy write or a new AI fact query fail the build.
None of this changes a field decision; it makes an existing one auditable.

| Control | Where | What it enforces |
|---|---|---|
| Guarded production audit | `scripts/phase6-production-audit.js` | `--acknowledge-production`, exact `--confirm-host`, TLS for a non-loopback host, `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`, `default_transaction_read_only=on` for both analyzers, ten expected tables (the eight fact tables plus both retired tables), output outside the repository, `0700` run directory and `0600` artifacts with a SHA-256 manifest |
| Decision register | `scripts/phase6-decisions.js` | One row per legacy-only and conflicting record with both values, both record ids and both timestamps; decision/reviewer/rationale columns start blank; the backfill packet says `Authorization: NOT GRANTED` and cannot apply anything |
| Ownership guard | `scripts/phase6-ownership-guard.js` + `scripts/phase6-legacy-read-baseline.json` | Fails on a new write to `pt_os_measurements`/`client_fitness_profiles` or a legacy `pt_clients` fact, a new legacy-table read outside the baseline, a new direct AI client-fact query, or a baseline entry whose code was removed |
| CI | `.github/workflows/ci.yml` | The guard runs with the lint job (no database); the guarded audit runs against `phase4_shape` in the test job, so the read-only proof cannot skip |

Current guard result: **343 files scanned, 23 registered dependencies, PASS**.
The 23 are 11 legacy reads, 2 deliberate legacy writes (the Fitness Testing
cache sync) and 10 bounded AI direct reads. Each carries an owner, a reason and
a sunset condition. A conflict is never auto-overwritten: only a `legacy_only`
row whose owner field is `NULL` and whose value comes from exactly one legacy
source is backfill-eligible.

On the full `phase4_shape` fixture the guarded audit reports **981 legacy-only,
628 conflicting, 1,609 records, 27 unapplied candidates, validation ok**, and
`schema_removal.decision: NO-GO`. The scoped ORG_A run reports 908 / 581 /
1,489 / 25. The production target has not been audited because no read-only
production dump or replica has been supplied; fixture evidence is not a
substitute. See `docs/implementation/PHASE6-PRODUCTION-READINESS-REPORT.md`.

## 18. Column-complete audit (Phase 7)

Phase 5 reconciles the D1–D25 fact registers. Phase 7 closes the remaining
gap: it audits **all 22 columns of `pt_os_measurements` and all 17 columns of
`client_fitness_profiles`**, including the columns that have no D-register.
`scripts/phase7-legacy-column-audit.js` introspects the live schema, refuses an
unregistered or missing column, and emits one provenance row per populated
cell.

| Column class | Count | Rule |
|---|---:|---|
| Identity (`id`) | 2 | Row key, never a fact to migrate |
| Tenant (`client_id`, `organization_id`) | 3 | `pt_os_measurements` uses the `pt_clients` join; the profile `organization_id` must equal the client organization |
| Metadata (`created_at`, `updated_at`) | 3 | Insert/update bookkeeping |
| Fact with a canonical owner | 24 | Compared against the latest owner row; `match`, `conflict` or `legacy_only` |
| Fact with no canonical owner | 7 | `assignment_id`, `shoulders_cm`, three photo URLs, `notes`, `measured_by` |

The audit reports tenant findings separately: orphan client, client without an
organization, profile/client organization mismatch, archived client, and an
owner row that belongs to another organization. An owner row from another
organization is never used, even for display.

A Phase 7 backfill candidate is narrower than the D1–D25 candidate: the owner
row must exist, the owner field must be `NULL`, the mapping must be exact, and
exactly one legacy source may supply the fact. On the fixture there are **0**
such candidates; all populated profile facts have at least two legacy copies or
an ambiguous mapping, so they are review-only. Conflicts are never
auto-overwritten.

Fixture evidence, scoped to ORG_A:

| Metric | Value |
|---|---:|
| Legacy rows audited | 150 measurements + 250 profiles |
| Out-of-scope rows (other organization) | 12 + 20 |
| Populated cells | 3,100 |
| Fact cells | 1,400 |
| Match / conflict / legacy-only | 491 / 509 / 400 |
| No canonical owner | 0 populated (7 columns named) |
| Tenant-blocked | 0 |
| Orphan clients / org mismatches / owner-org mismatches | 0 / 0 / 0 |
| Backfill candidates | 0 |
| Validation | ok |

The all-organization fixture run reports 3,348 populated cells (1,512 facts),
531 matches, 549 conflicts and 432 legacy-only facts. Both runs return
`schema_removal.decision: NO-GO`.

**Production evidence remains BLOCKED.** No production dump, replica or
read-only credential has been supplied, so every number above is fixture
evidence. The Phase 7 audit is wired into the same guarded wrapper as Phase 6,
which now requires ten tables and runs both analyzers read-only. The schema
removal gate combines both reports; it can only become
`ELIGIBLE_FOR_REVIEW` when the production run shows zero unresolved conflicts,
zero legacy-only fact cells, zero populated ownerless columns, zero tenant
findings, and zero unapplied candidates. See
`docs/implementation/PHASE7-PRODUCTION-READINESS-REPORT.md`.

## 19. Final closure (Phase 8)

Phase 8 closes the register. All D1–D25 rows now have a verified single
canonical writer, a documented reader precedence, and a status:

- **Closed** — D1, D2, D17, D19, D20, D21, D22.
- **Closed with fallback** — D3–D16, D18, D23, D24, D25. The legacy column
  stays readable and its reader is registered with an owner and a sunset
  condition. No column is removed without production evidence.

The seven ownerless `pt_os_measurements` columns (`assignment_id`,
`shoulders_cm`, `photo_front_url`, `photo_side_url`, `photo_back_url`,
`notes`, `measured_by`) remain **read-only, unowned and undecided**. All are
0 populated in the fixture. `shoulders_cm` is the only one with a live reader
(the member progress page); a drop would be a visible product change.

Object-field legacy reads — which the SQL guard cannot see — are registered in
§7 of `docs/implementation/PHASE8-FINAL-CLOSURE-REPORT.md`. The important ones
all pass through `client-facts`, which is canonical-first and logs
`ownership.deprecated_read` on every fallback.

The member self-service audit gap is closed: `PATCH /api/me/profile` now logs
`client.contact.update` (only when a field actually changed) and
`POST`/`DELETE /api/me/photo` log `client.photo.update`.

Verdicts remain **code PASS, production BLOCKED, schema removal NO-GO**. The
blockers are unchanged and are not fixture-fixable: no production evidence,
628 undecided conflicts, 27 unauthorized backfill candidates, and the seven
ownerless columns. See `docs/implementation/PHASE8-FINAL-CLOSURE-REPORT.md`.
