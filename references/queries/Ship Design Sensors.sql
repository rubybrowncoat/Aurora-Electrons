SELECT
	ct.TypeDescription
	,sdc.Resolution
	,CASE
		when sdc.MaxSensorRange = 0 then sdc.ComponentValue
		else cast(sdc.MaxSensorRange / 1000 / 10 as int) / 100.0 
		END
	as SensorRangeMkm
	,sc.ClassName
	,sc.TotalNumber
	--,sc.MoraleCheckRequired as IsMilitary
	,sc.Obsolete
	,sdc.Name
	,rt.Obsolete
	,sdc.ComponentValue
	,sdc.*
FROM
	vw_const as c
inner JOIN
	FCT_ShipClass as sc
on
	sc.RaceID = c.RaceID
inner JOIN
	FCT_HullDescription as hd
on
	hd.HullDescriptionID = sc.HullDescriptionID
inner JOIN
	FCT_ClassComponent as cc
on
	cc.ClassID = sc.ShipClassID
inner JOIN
	FCT_ShipDesignComponents as sdc
on
	sdc.SDComponentID = cc.ComponentID
inner JOIN
	FCT_RaceTech as rt
on
	rt.TechID = sdc.SDComponentID
inner JOIN
	DIM_ComponentType as ct
on
	ct.ComponentTypeID = sdc.ComponentTypeID
WHERE
	hd.Description = 'Sensor Platform'
AND
	sdc.ComponentTypeID in -- 8 = thermal, 24 = active, 41 = EM
	(
		8
		,
		24
		,
		41
	) 
order by
	ct.TypeDescription
	,sdc.Resolution
	,sdc.MaxSensorRange
	,sdc.ComponentValue
	,sc.ClassName

