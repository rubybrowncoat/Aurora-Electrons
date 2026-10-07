SELECT
	hd.Description as Hull
	,sc.ClassName
	,sc.CommanderPriority
	,sc.ShipClassID
	,'' || sc.ShipClassID || ', -- ' || sc.ClassName
	,sc.*
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
WHERE
	sc.ClassShippingLineID = 0
order by
	sc.CommanderPriority
	,hd.Description
	,sc.ClassName
	
--
/*
update FCT_ShipClass
set CommanderPriority = CommanderPriority + 10
where ShipClassID in (				-- 82763)
--82715, -- Shadow
--81556, -- Shadow-
80323, -- ShadowA
--80713, -- ShadowB
--82108, -- ShadowX

0)

*/