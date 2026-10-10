-- Types are placeholders: the ER model declares no data types. Review before execution.

-- Step 1: E:PART is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
CREATE TABLE PART (
  PartNo TEXT NOT NULL,
  Weight TEXT,
  Color TEXT,
  PRIMARY KEY (PartNo)
);

-- Step 1: E:PROJECT is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
CREATE TABLE PROJECT (
  ProjectNo TEXT NOT NULL,
  Budget TEXT,
  PRIMARY KEY (ProjectNo)
);

-- Step 1: E:SUPPLIER is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.
CREATE TABLE SUPPLIER (
  SupplierNo TEXT NOT NULL,
  SupplierName TEXT,
  PRIMARY KEY (SupplierNo)
);

-- Step 7: R:SUPPLY is n-ary (E:SUPPLIER 0..N, E:PROJECT 0..N, E:PART 1..N); PK = FKs of many ends only; max=1 ends excluded.
CREATE TABLE SUPPLY (
  SUPPLIER_SupplierNo TEXT NOT NULL,
  PROJECT_ProjectNo TEXT NOT NULL,
  PART_PartNo TEXT NOT NULL,
  Quantity TEXT,
  PRIMARY KEY (SUPPLIER_SupplierNo, PROJECT_ProjectNo, PART_PartNo),
  FOREIGN KEY (SUPPLIER_SupplierNo) REFERENCES SUPPLIER (SupplierNo),
  FOREIGN KEY (PROJECT_ProjectNo) REFERENCES PROJECT (ProjectNo),
  FOREIGN KEY (PART_PartNo) REFERENCES PART (PartNo)
);

-- Note: R:SUPPLY, SUPPLY#2 (E:PART 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
