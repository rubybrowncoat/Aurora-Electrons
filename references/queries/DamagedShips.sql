SELECT
	s.ShipName
	,f.FleetName
	,a.DamagedArmorCells
	,x.DamagedComponents
	,*
FROM
	vw_const as c
inner JOIN
	FCT_Fleet as f on f.RaceID = c.RaceID
inner JOIN
	FCT_Ship as s on s.FleetID = f.FleetID
left JOIN
	(select ShipID, count(*) as DamagedArmorCells from FCT_ArmourDamage group by ShipID) as a on a.ShipID = s.ShipID
left JOIN
	(select ShipID, count(*) as DamagedComponents from FCT_DamagedComponent group by ShipID) as x on x.ShipID = s.ShipID
WHERE
	a.ShipID is not null
or
	x.ShipID is not null
order by
	s.ShipName