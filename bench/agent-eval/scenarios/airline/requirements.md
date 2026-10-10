# Requirements: Airline

1. An AIRPORT is identified by AirportCode and records Name and City.
2. A FLIGHT is identified by FlightNo and records Airline.
3. A FLIGHT_LEG is weak and has LegNo as its partial key.
4. An AIRPLANE is identified by AirplaneId and records Capacity.
5. A RESERVATION is identified by ReservationId and records SeatNo, TravelDate and PassengerName; PassengerName is composite with FirstName and LastName parts.
6. A FLIGHT records LegCount as a derived attribute computed from its flight legs.
7. Each FLIGHT_LEG belongs to exactly one FLIGHT and is identified by that flight together with LegNo; each FLIGHT has at least one leg and may have any number.
8. Each FLIGHT_LEG departs from exactly one AIRPORT; each AIRPORT is the departure airport of zero or any number of legs.
9. Each FLIGHT_LEG arrives at exactly one AIRPORT; each AIRPORT is the arrival airport of zero or any number of legs.
10. Each FLIGHT_LEG uses exactly one AIRPLANE; each AIRPLANE is assigned to zero or any number of legs in this schedule.
11. Each RESERVATION reserves a seat on exactly one FLIGHT_LEG; each FLIGHT_LEG has zero or any number of reservations.
