SELECT
	sc.*
	,s.*
	
FROM
	FCT_Population as p
inner JOIN
	FCT_MoveOrders as mo
on
	mo.PopulationID = p.PopulationID
inner JOIN
	FCT_Fleet as f
on
	f.FleetID = mo.FleetID
inner JOIN
	FCT_Ship as s
on
	s.FleetID = f.FleetID
inner JOIN
	FCT_ShipCargo as sc
on
	sc.ShipID = s.ShipID
WHERE
	p.PopName like 'kab%'