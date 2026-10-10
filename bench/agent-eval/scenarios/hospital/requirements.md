# Requirements: Hospital

1. A PATIENT is identified by PatientId and records Name.
2. A DOCTOR is identified by DoctorId and records Name and Specialty.
3. A WARD is identified by WardCode and records Name.
4. An ADMISSION is identified by AdmissionId and records AdmissionDate and DischargeDate.
5. Each ADMISSION is for exactly one PATIENT; each PATIENT has zero or any number of admissions.
6. Each ADMISSION is allocated to exactly one WARD; each WARD accommodates zero or any number of admissions.
7. CARE_ASSIGNMENT is one ternary relationship between PATIENT, DOCTOR and WARD, recording which doctor is authorized to care for which patient in which ward; each participant occurs in zero or any number of assignment triples.
8. CARE_ASSIGNMENT records CarePlan for each patient-doctor-ward triple.
9. Authorization is specific to the complete CARE_ASSIGNMENT triple: a doctor's authorization for a patient in one ward implies nothing about another ward, and joining the three pairwise projections can invent unauthorized triples, so this relationship must not be split into binaries.
