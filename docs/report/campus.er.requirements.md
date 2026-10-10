# Requirements: Hospital operations

<!-- chen-er requirements v1: one requirement per list item. The comment after each item keeps its id and trace for chen serve; leave it in place. -->

1. Each hospital has one or more wards, and every ward belongs to exactly one hospital. <!-- chen-er {"id":"r1"} -->
2. Every ward has one or more rooms; each room has one or more beds and belongs to exactly one ward. <!-- chen-er {"id":"r2"} -->
3. Staff members have an identifier, a composite name, a role and multiple qualifications; each staff member is assigned to exactly one ward. <!-- chen-er {"id":"r3"} -->
4. A staff member may supervise several trainees, and each trainee has at most one supervisor. <!-- chen-er {"id":"r4"} -->
5. Patients have an identifier, a composite name, a birth date and an allergy record; staff may treat many patients, recording the treatment start date. <!-- chen-er {"id":"r5"} -->
6. Each admission belongs to one patient and is identified by that patient and its admission date; it records a reason and an optional discharge date. <!-- chen-er {"id":"r6"} -->
7. An admission occupies at most one bed and has one attending staff member; its discharging clinician may be different. <!-- chen-er {"id":"r7"} -->
8. Hospitals employ staff members independently of ward assignments, and shifts roster one or more staff members. <!-- chen-er {"id":"r8"} -->
