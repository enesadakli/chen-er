PART(<u>PartNo</u>, Weight, Color)  
Step 1: E:PART is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.

PROJECT(<u>ProjectNo</u>, Budget)  
Step 1: E:PROJECT is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.

SUPPLIER(<u>SupplierNo</u>, SupplierName)  
Step 1: E:SUPPLIER is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.

SUPPLY(<u>SUPPLIER\_SupplierNo</u>, <u>PROJECT\_ProjectNo</u>, <u>PART\_PartNo</u>, Quantity)  
SUPPLIER\_SupplierNo → SUPPLIER(SupplierNo) [NOT NULL]  
PROJECT\_ProjectNo → PROJECT(ProjectNo) [NOT NULL]  
PART\_PartNo → PART(PartNo) [NOT NULL]  
Step 7: R:SUPPLY is n-ary (E:SUPPLIER 0..N, E:PROJECT 0..N, E:PART 1..N); PK = FKs of many ends only; max=1 ends excluded.

Notes:

- R:SUPPLY, SUPPLY#2 (E:PART 1..N): minimum participation 1 requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.
