SELECT
	f.FleetName
	,s.ShipName
	,*
FROM
	vw_const as c
inner JOIN	FCT_Fleet		as f 			on	f.RaceID = c.RaceID
inner join	FCT_Ship		as s 			on	s.FleetID = f.FleetID
inner JOIN	FCT_ShipClass	as sc 			on	sc.ShipClassID = s.ShipClassID
WHERE
	(sc.MiningModules > 0 and f.FleetName not like '___OM %')	
or
	(sc.Harvesters > 0 and f.FleetName not like '___SH %')
or
	(sc.Terraformers > 0 and f.FleetName not like '___TF %')
order by
	f.FleetName