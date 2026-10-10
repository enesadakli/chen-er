# Requirements: Car rental

1. Record branches with a unique branch number and a location.
2. Record cars with a unique registration number and a model.
3. Each car is kept at exactly one branch; a branch may have no cars or any number of cars.
4. Record customers with a unique licence number and a name.
5. Each rental has its own unique rental number, a pickup date and a return date; keep the rental as a separately numbered record.
6. Each rental is for exactly one customer and exactly one car; a customer may have no rentals or any number of rentals, and a car may appear in no rentals or any number of rentals over time.
7. A rental may be paid in no payments yet or in any number of payments; each payment belongs to exactly one rental.
8. A payment is numbered only within its rental; numbers may repeat across rentals but never within the same rental, and each payment records its date and amount.
9. Each car offers one or more insurance options, known only by their names; different cars may offer the same named option.
10. Only options currently offered by at least one car need to be kept; there are no other details about an option.
