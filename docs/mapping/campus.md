PATIENT(<u>PatientId</u>, Name\_First, Name\_Last, BirthDate, Allergy)  
Step 1: E:PATIENT is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.

HOSPITAL(<u>HospitalId</u>, Name, City)  
Step 1: E:HOSPITAL is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.

SHIFT(<u>ShiftId</u>, Day, StartTime)  
Step 1: E:SHIFT is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.

WARD(<u>WardCode</u>, Name, Specialty, HOSPITAL\_HospitalId)  
HOSPITAL\_HospitalId → HOSPITAL(HospitalId) [NOT NULL]  
Step 1: E:WARD is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.  
Step 4: R:HAS\_WARD is 1:N (E:HOSPITAL 1..N, E:WARD 1..1); FK on E:WARD, the max=1 (relational N-side) end.

ROOM(<u>RoomNo</u>, Floor, WARD\_WardCode)  
WARD\_WardCode → WARD(WardCode) [NOT NULL]  
Step 1: E:ROOM is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.  
Step 4: R:HAS\_ROOM is 1:N (E:WARD 1..N, E:ROOM 1..1); FK on E:ROOM, the max=1 (relational N-side) end.

BED(<u>BedNo</u>, Kind, ROOM\_RoomNo)  
ROOM\_RoomNo → ROOM(RoomNo) [NOT NULL]  
Step 1: E:BED is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.  
Step 4: R:HAS\_BED is 1:N (E:ROOM 1..N, E:BED 1..1); FK on E:BED, the max=1 (relational N-side) end.

STAFF(<u>StaffId</u>, Name\_First, Name\_Last, Role, WARD\_WardCode, HOSPITAL\_HospitalId, supervisor\_StaffId)  
WARD\_WardCode → WARD(WardCode) [NOT NULL]  
HOSPITAL\_HospitalId → HOSPITAL(HospitalId) [NOT NULL]  
supervisor\_StaffId → STAFF(StaffId)  
Step 1: E:STAFF is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.  
Step 4: R:ASSIGNED\_TO is 1:N (E:STAFF 1..1, E:WARD 0..N); FK on E:STAFF, the max=1 (relational N-side) end.  
Step 4: R:EMPLOYS is 1:N (E:HOSPITAL 1..N, E:STAFF 1..1); FK on E:STAFF, the max=1 (relational N-side) end.  
Step 4: R:SUPERVISES is 1:N (E:STAFF/supervisor 0..N, E:STAFF/trainee 0..1); FK on E:STAFF/trainee, the max=1 (relational N-side) end.

ADMISSION(<u>PATIENT\_PatientId</u>, <u>AdmittedOn</u>, DischargedOn, Reason, ATTENDS\_StaffId, DISCHARGES\_StaffId, BED\_BedNo)  
PATIENT\_PatientId → PATIENT(PatientId) [NOT NULL]  
ATTENDS\_StaffId → STAFF(StaffId) [NOT NULL]  
DISCHARGES\_StaffId → STAFF(StaffId)  
BED\_BedNo → BED(BedNo)  
UNIQUE(BED\_BedNo)  
Step 2: E:ADMISSION is weak, identified by R:ADMISSION\_OF; PK = owner PK(s) + partial key.  
Step 4: R:ATTENDS is 1:N (E:STAFF 0..N, E:ADMISSION 1..1); FK on E:ADMISSION, the max=1 (relational N-side) end.  
Step 4: R:DISCHARGES is 1:N (E:STAFF 0..N, E:ADMISSION 0..1); FK on E:ADMISSION, the max=1 (relational N-side) end.  
Step 3: R:OCCUPIES is 1:1 (E:BED 0..1, E:ADMISSION 0..1); FK on E:ADMISSION, the chosen end; both or neither end is total: choose the first entity/end id in lexical order.

ROSTERS(<u>STAFF\_StaffId</u>, <u>SHIFT\_ShiftId</u>)  
STAFF\_StaffId → STAFF(StaffId) [NOT NULL]  
SHIFT\_ShiftId → SHIFT(ShiftId) [NOT NULL]  
Step 5: R:ROSTERS is M:N (E:STAFF 0..N, E:SHIFT 1..N); PK = all participating PKs.

TREATS(<u>STAFF\_StaffId</u>, <u>PATIENT\_PatientId</u>, StartDate)  
STAFF\_StaffId → STAFF(StaffId) [NOT NULL]  
PATIENT\_PatientId → PATIENT(PatientId) [NOT NULL]  
Step 5: R:TREATS is M:N (E:STAFF 0..N, E:PATIENT 0..N); PK = all participating PKs.

STAFF\_Qualifications(<u>STAFF\_StaffId</u>, <u>Qualifications</u>)  
STAFF\_StaffId → STAFF(StaffId) [NOT NULL]  
Step 6: A:STAFF.Qualifications is multivalued; PK = owner PK + stored simple value components.

Notes:

- R:DISCHARGES: The discharging clinician can differ from the attending one recorded by ATTENDS.
- R:EMPLOYS: Employment is contractual with the hospital; ward assignment may change without changing the employer.
- R:EMPLOYS, EMPLOYS#0 (E:HOSPITAL 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
- R:HAS\_BED, HAS\_BED#0 (E:ROOM 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
- R:HAS\_ROOM, HAS\_ROOM#0 (E:WARD 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
- R:HAS\_WARD, HAS\_WARD#0 (E:HOSPITAL 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
- R:ROSTERS, ROSTERS#1 (E:SHIFT 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
