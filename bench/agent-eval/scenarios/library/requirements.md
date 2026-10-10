# Requirements: Library

1. A BOOK is identified by ISBN and records Title.
2. A COPY is a weak entity with CopyNo as its partial key and records Condition.
3. A MEMBER is identified by MemberId and records Name.
4. Each COPY belongs to exactly one BOOK, which identifies it together with CopyNo; each BOOK has at least one COPY and may have any number of copies.
5. A COPY can have zero or one current loan to a MEMBER; a MEMBER can borrow zero or any number of copies.
6. The LOAN relationship records LoanDate for the current borrowing of a copy by a member; historical loans are outside this model.
