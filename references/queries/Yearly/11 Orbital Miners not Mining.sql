select 
	f.FleetName
	,f.FleetID
	,mo.Description as MoveOrderDescription
	--,mo_release.FleetID
	,sb.*		
FROM
	vw_const as c
inner JOIN
	FCT_Race as r
on
	r.RaceID = c.RaceID
inner join
	FCT_Fleet as f
on
	f.RaceID = c.RaceID
left JOIN
	FCT_MoveOrders as mo
on
	mo.FleetID = f.FleetID
left JOIN
(
	SELECT
		FleetID
	FROM
		FCT_MoveOrders
	WHERE
		description like 'FLT: ___OM %'	-- an orbital mining fleet is the destination
	AND
		MoveActionID = 161	-- release tractored ships
) as mo_release
on mo_release.FleetID = f.FleetID
left join
(
	select distinct SystemBodyID from FCT_MineralDeposit
) as md	
on
	md.SystemBodyID = f.OrbitBodyID
left JOIN
	FCT_SystemBody as sb
on
	sb.SystemBodyID = f.OrbitBodyID
inner JOIN
	FCT_Ship as s
on
	s.FleetID = f.FleetID
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
WHERE
	sc.MiningModules > 0
AND
	mo_release.FleetID is NULL								-- fleet does not have orders to release a tractored ship at an orbital mining fleet
AND
(
		md.SystemBodyID is null								-- fleet is not at a body with mineral deposits
	OR
		sb.Radius * 2 > r.MaximumOrbitalMiningDiameter		-- fleet is at a body too large for orbital mining
)
order by
	f.FleetName
	,f.FleetID
	,mo.MoveOrder 
