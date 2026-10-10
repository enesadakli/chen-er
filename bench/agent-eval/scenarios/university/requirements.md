# Requirements: University

1. A STUDENT is identified by StudentId and records Name.
2. A COURSE is identified by CourseCode and records Title and Credits.
3. A SECTION is weak, has SectionNo as its partial key, and records Room.
4. An INSTRUCTOR is identified by InstructorId and records Name.
5. Each SECTION belongs to exactly one COURSE and is identified by that course together with SectionNo; each COURSE offers zero or any number of sections.
6. Each SECTION is taught by exactly one INSTRUCTOR; each INSTRUCTOR teaches zero or any number of sections.
7. A STUDENT enrolls in zero or any number of sections; a SECTION enrolls zero or any number of students.
8. The ENROLLMENT relationship records Grade for each student-section enrollment.
9. In PREREQUISITE, a COURSE in the dependent role requires zero or any number of prerequisite courses, and a COURSE in the prerequisite role is required by zero or any number of dependent courses.
