SELECT
	f.FleetName
	,o.Description
	,*
FROM
	fct_fleet as f
inner JOIN vw_const as c on c.RaceID = f.RaceID
left join
(
SELECT
	s.FleetID
	,sdc_grav.SDComponentID as SDComponentID_grav
	,sdc_geo.SDComponentID as SDComponentID_geo
FROM
	FCT_Ship as s
inner JOIN vw_const as c on c.RaceID = s.RaceID
inner JOIN	
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
inner JOIN
	FCT_ClassComponent as cc
on
	cc.ClassID = sc.ShipClassID
left join
	FCT_ShipDesignComponents as sdc_grav
on
	sdc_grav.SDComponentID = cc.ComponentID
AND
	sdc_grav.ComponentTypeID = 6		--	Grav sensors
left join
	FCT_ShipDesignComponents as sdc_geo
on
	sdc_geo.SDComponentID = cc.ComponentID
AND
	sdc_geo.ComponentTypeID = 7		--	Geo sensors
WHERE
	sdc_grav.SDComponentID is not null
or
	sdc_geo.SDComponentID is not null
) as sc		-- fleetid of all fleets with a geo or grav sensor, and the componentid of each such sensor (null if not present)
on
	sc.FleetID = f.FleetID
inner JOIN
	FCT_MoveOrders as o
on
	o.FleetID = f.FleetID
AND
	o.MoveActionID in (9,12)
where
	(o.MoveActionID = 12 and sc.SDComponentID_grav is null)		--	Gravitational Survey
or
	(o.MoveActionID = 9 and sc.SDComponentID_geo is null)		--	Geological Survey
order by
	f.FleetName, o.MoveOrder
