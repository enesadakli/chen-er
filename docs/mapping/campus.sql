-- Types are placeholders: the ER model declares no data types. Review before execution.

-- Step 1: E:PATIENT is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
CREATE TABLE PATIENT (
  PatientId TEXT NOT NULL,
  Name_First TEXT,
  Name_Last TEXT,
  BirthDate TEXT,
  Allergy TEXT,
  PRIMARY KEY (PatientId)
);

-- Step 1: E:HOSPITAL is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
CREATE TABLE HOSPITAL (
  HospitalId TEXT NOT NULL,
  Name TEXT,
  City TEXT,
  PRIMARY KEY (HospitalId)
);

-- Step 1: E:SHIFT is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
CREATE TABLE SHIFT (
  ShiftId TEXT NOT NULL,
  Day TEXT,
  StartTime TEXT,
  PRIMARY KEY (ShiftId)
);

-- Step 1: E:WARD is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
-- Step 4: R:HAS_WARD is 1:N (E:HOSPITAL 1..N, E:WARD 1..1); FK on E:WARD, the max=1 (relational N-side) end.
CREATE TABLE WARD (
  WardCode TEXT NOT NULL,
  Name TEXT,
  Specialty TEXT,
  HOSPITAL_HospitalId TEXT NOT NULL,
  PRIMARY KEY (WardCode),
  FOREIGN KEY (HOSPITAL_HospitalId) REFERENCES HOSPITAL (HospitalId)
);

-- Step 1: E:ROOM is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
-- Step 4: R:HAS_ROOM is 1:N (E:WARD 1..N, E:ROOM 1..1); FK on E:ROOM, the max=1 (relational N-side) end.
CREATE TABLE ROOM (
  RoomNo TEXT NOT NULL,
  Floor TEXT,
  WARD_WardCode TEXT NOT NULL,
  PRIMARY KEY (RoomNo),
  FOREIGN KEY (WARD_WardCode) REFERENCES WARD (WardCode)
);

-- Step 1: E:BED is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
-- Step 4: R:HAS_BED is 1:N (E:ROOM 1..N, E:BED 1..1); FK on E:BED, the max=1 (relational N-side) end.
CREATE TABLE BED (
  BedNo TEXT NOT NULL,
  Kind TEXT,
  ROOM_RoomNo TEXT NOT NULL,
  PRIMARY KEY (BedNo),
  FOREIGN KEY (ROOM_RoomNo) REFERENCES ROOM (RoomNo)
);

-- Step 1: E:STAFF is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
-- Step 4: R:ASSIGNED_TO is 1:N (E:STAFF 1..1, E:WARD 0..N); FK on E:STAFF, the max=1 (relational N-side) end.
-- Step 4: R:EMPLOYS is 1:N (E:HOSPITAL 1..N, E:STAFF 1..1); FK on E:STAFF, the max=1 (relational N-side) end.
-- Step 4: R:SUPERVISES is 1:N (E:STAFF/supervisor 0..N, E:STAFF/trainee 0..1); FK on E:STAFF/trainee, the max=1 (relational N-side) end.
CREATE TABLE STAFF (
  StaffId TEXT NOT NULL,
  Name_First TEXT,
  Name_Last TEXT,
  Role TEXT,
  WARD_WardCode TEXT NOT NULL,
  HOSPITAL_HospitalId TEXT NOT NULL,
  supervisor_StaffId TEXT,
  PRIMARY KEY (StaffId),
  FOREIGN KEY (WARD_WardCode) REFERENCES WARD (WardCode),
  FOREIGN KEY (HOSPITAL_HospitalId) REFERENCES HOSPITAL (HospitalId),
  FOREIGN KEY (supervisor_StaffId) REFERENCES STAFF (StaffId)
);

-- Step 2: E:ADMISSION is weak, identified by R:ADMISSION_OF; PK = owner PK(s) + partial key.
-- Step 4: R:ATTENDS is 1:N (E:STAFF 0..N, E:ADMISSION 1..1); FK on E:ADMISSION, the max=1 (relational N-side) end.
-- Step 4: R:DISCHARGES is 1:N (E:STAFF 0..N, E:ADMISSION 0..1); FK on E:ADMISSION, the max=1 (relational N-side) end.
-- Step 3: R:OCCUPIES is 1:1 (E:BED 0..1, E:ADMISSION 0..1); FK on E:ADMISSION, the chosen end; both or neither end is total: choose the first entity/end id in lexical order.
CREATE TABLE ADMISSION (
  AdmittedOn TEXT NOT NULL,
  DischargedOn TEXT,
  Reason TEXT,
  PATIENT_PatientId TEXT NOT NULL,
  STAFF_StaffId TEXT NOT NULL,
  STAFF_StaffId_2 TEXT,
  BED_BedNo TEXT,
  PRIMARY KEY (PATIENT_PatientId, AdmittedOn),
  UNIQUE (BED_BedNo),
  FOREIGN KEY (PATIENT_PatientId) REFERENCES PATIENT (PatientId),
  FOREIGN KEY (STAFF_StaffId) REFERENCES STAFF (StaffId),
  FOREIGN KEY (STAFF_StaffId_2) REFERENCES STAFF (StaffId),
  FOREIGN KEY (BED_BedNo) REFERENCES BED (BedNo)
);

-- Step 5: R:ROSTERS is M:N (E:STAFF 0..N, E:SHIFT 1..N); PK = all participating PKs.
CREATE TABLE ROSTERS (
  STAFF_StaffId TEXT NOT NULL,
  SHIFT_ShiftId TEXT NOT NULL,
  PRIMARY KEY (STAFF_StaffId, SHIFT_ShiftId),
  FOREIGN KEY (STAFF_StaffId) REFERENCES STAFF (StaffId),
  FOREIGN KEY (SHIFT_ShiftId) REFERENCES SHIFT (ShiftId)
);

-- Step 5: R:TREATS is M:N (E:STAFF 0..N, E:PATIENT 0..N); PK = all participating PKs.
CREATE TABLE TREATS (
  STAFF_StaffId TEXT NOT NULL,
  PATIENT_PatientId TEXT NOT NULL,
  StartDate TEXT,
  PRIMARY KEY (STAFF_StaffId, PATIENT_PatientId),
  FOREIGN KEY (STAFF_StaffId) REFERENCES STAFF (StaffId),
  FOREIGN KEY (PATIENT_PatientId) REFERENCES PATIENT (PatientId)
);

-- Step 6: A:STAFF.Qualifications is multivalued; PK = owner PK + stored simple value components.
CREATE TABLE STAFF_Qualifications (
  STAFF_StaffId TEXT NOT NULL,
  Qualifications TEXT NOT NULL,
  PRIMARY KEY (STAFF_StaffId, Qualifications),
  FOREIGN KEY (STAFF_StaffId) REFERENCES STAFF (StaffId)
);

-- Note: R:DISCHARGES: The discharging clinician can differ from the attending one recorded by ATTENDS.
-- Note: R:DISCHARGES, DISCHARGES#0, E:STAFF: name collision; STAFF_StaffId renamed to STAFF_StaffId_2.
-- Note: R:EMPLOYS: Employment is contractual with the hospital; ward assignment may change without changing the employer.
-- Note: R:EMPLOYS, EMPLOYS#0 (E:HOSPITAL 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
-- Note: R:HAS_BED, HAS_BED#0 (E:ROOM 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
-- Note: R:HAS_ROOM, HAS_ROOM#0 (E:WARD 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
-- Note: R:HAS_WARD, HAS_WARD#0 (E:HOSPITAL 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
-- Note: R:ROSTERS, ROSTERS#1 (E:SHIFT 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
