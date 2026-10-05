SELECT
	f.FleetName
	,s.ShipName
	,*
FROM		vw_const as c
inner JOIN	FCT_Fleet		as f 			on	f.RaceID = c.RaceID
inner join	FCT_Ship		as s 			on	s.FleetID = f.FleetID
inner JOIN	FCT_ShipClass	as sc 			on	sc.ShipClassID = s.ShipClassID
WHERE
/*
	( f.FleetName like '___OM %' and s.ShipName not like 'Pick%' and s.ShipName not like 'Shovel%' and s.ShipName not like 'Spoon%' )
or
	( f.FleetName like '___SH %' and s.ShipName not like 'Pump%' and s.ShipName not like 'Squeeze%')
or
	( f.FleetName like '___TF %' and s.ShipName not like 'Plow%')
*/
	(sc.MiningModules = 0 and f.FleetName like '___OM %')	
or
	(sc.Harvesters = 0 and f.FleetName like '___SH %')
or
	(sc.Terraformers = 0 and f.FleetName like '___TF %')