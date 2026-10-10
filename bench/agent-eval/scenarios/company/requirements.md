# Requirements: Company

1. An EMPLOYEE is identified by EmployeeId and records Name, BirthDate and Salary.
2. A DEPARTMENT has two alternative unique identifiers, DepartmentNo and DepartmentName.
3. A PROJECT is identified by ProjectNo and records ProjectName and Location.
4. A DEPENDENT is weak, has DependentName as its partial key, and records BirthDate and Kinship.
5. A DEPARTMENT records Locations as a multivalued attribute.
6. Each EMPLOYEE works for exactly one DEPARTMENT; each DEPARTMENT employs at least one EMPLOYEE and may employ any number.
7. Each PROJECT is controlled by exactly one DEPARTMENT; each DEPARTMENT controls zero or any number of projects.
8. Each DEPENDENT belongs to exactly one EMPLOYEE and is identified by that employee together with DependentName; each EMPLOYEE has zero or any number of dependents.
9. Each DEPARTMENT is managed by exactly one EMPLOYEE; each EMPLOYEE manages zero or one department.
10. The MANAGES relationship records StartDate of that employee's management of that department.
11. In SUPERVISION, an EMPLOYEE in the subordinate role has zero or one supervisor, while an EMPLOYEE in the supervisor role supervises zero or any number of subordinates.
12. Each EMPLOYEE works on zero or any number of projects; each PROJECT has at least one working EMPLOYEE and may have any number.
13. The WORKS_ON relationship records Hours for each employee-project assignment.
