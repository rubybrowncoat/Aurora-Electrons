SELECT
	mn.MineralName
	,sc.Amount
	,f.FleetName
FROM
	vw_const as c
inner JOIN
	fct_fleet as f on f.RaceID = c.RaceID
inner JOIN
	fct_ship as s on s.FleetID = f.FleetID
inner JOIN
	FCT_ShipCargo as sc on sc.ShipID = s.ShipID
AND
	sc.CargoTypeID = 3		-- mineral cargo type
inner JOIN
	vw_MineralNames as mn on mn.MineralID = sc.CargoID
order by
	sc.CargoID
	,sc.Amount desc
	,f.FleetName