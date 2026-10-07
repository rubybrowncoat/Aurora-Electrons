with CTE_Const as 
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
)

SELECT
	sc.Amount
	,p.PopName
	,mo.*
FROM
	fct_fleet as f
inner JOIN
	CTE_Const
on
	CTE_Const.RaceID = f.RaceID
inner JOIN
	fct_ship as s
on
	s.FleetID = f.FleetID
inner JOIN
	FCT_ShipCargo as sc
on
	sc.ShipID = s.ShipID
inner JOIN
	FCT_MoveOrders as mo
on
	mo.FleetID = f.FleetID
inner JOIN
	FCT_Population as p
on
	p.PopulationID = mo.PopulationID
WHERE
	f.CivilianFunction = 2
AND
	mo.MoveActionID = 6