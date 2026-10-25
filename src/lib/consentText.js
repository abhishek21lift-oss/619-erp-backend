// The consent wording printed on signed PDFs.
//
// Kept in one pure module so the PDF generators and the cross-repo parity
// check (619-erp-frontend/scripts/assert-scoring-parity.ts) can read the same
// strings without loading pdfkit or storage.
//
// PAR-Q: only `info_true` is displayed by the current wizard; the remaining
// keys are printed for older records that stored all seven checkboxes.
const PARQ_CONSENT_LABELS = Object.freeze({
  info_true: 'The answers in this screening are true and complete to the best of my knowledge, and I will tell my trainer if my health changes.',
  understands_risk: 'I understand that physical exercise carries inherent risks, including the risk of injury.',
  will_inform_changes: 'I agree to inform my trainer of any changes to my health status before or during training.',
  understands_incorrect_info_risk: 'I understand that providing incorrect or incomplete information may put my health at risk.',
  voluntary_participation: 'I am participating in this training program voluntarily and of my own free will.',
  consents_emergency_care: 'I consent to receive emergency medical care/first aid if required during a session.',
  agrees_data_storage: 'I agree to my health data being securely stored and used for training purposes.',
});

// Must stay byte-identical to FINAL_ACK_FIELDS in the frontend.
const INFORMED_CONSENT_ACK_LABELS = Object.freeze({
  understands_confidentiality: 'I understand my personal and medical information will remain confidential and will only be used for designing, monitoring and improving my personal training program. Parts of my programme may be drafted with the help of AI tools; to do this, relevant details (such as my goals, measurements and health or injury notes, but not my phone number) are sent to an AI service provider that is not permitted to store or train on them, and my trainer reviews everything before it is used.',
  voluntary_participation: 'I understand my participation is voluntary and I can withdraw at any time.',
  final_declaration: 'I confirm that: I have read this entire informed consent document; I understand the risks; I understand the benefits; I have asked all my questions; my questions have been answered; I voluntarily agree to participate.',
});

module.exports = { PARQ_CONSENT_LABELS, INFORMED_CONSENT_ACK_LABELS };
