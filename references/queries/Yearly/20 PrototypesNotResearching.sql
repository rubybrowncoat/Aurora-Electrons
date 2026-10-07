--prototype components marked for research but no project assigned
SELECT
	sdc.Name
	,rt.Obsolete
	,rp.Facilities
	,sdc.Prototype	
	,*
FROM
	vw_const as c
inner JOIN
	FCT_RaceTech as rt on rt.RaceID = c.RaceID
inner JOIN
	FCT_TechSystem as ts on ts.RaceID = c.RaceID and ts.TechSystemID = rt.TechID
inner JOIN
	FCT_ShipDesignComponents as sdc on sdc.SDComponentID = rt.TechID --ts.TechSystemID
/*
left JOIN
	FCT_ClassComponent as cc
on
	cc.ComponentID = sdc.SDComponentID
*/
left JOIN
	FCT_ResearchProject as rp
on
	rp.TechID = rt.TechID
left JOIN
	FCT_ResearchQueue as rq
on
	rq.TechSystemID = rt.TechID
WHERE
	sdc.Prototype = 3	-- sdc.Prototype: 0 = not; 1 = not marked for research;	3 = marked for research
AND
	rp.TechID is null
AND
	rq.TechSystemID is null
order by
	sdc.Prototype desc
	,sdc.Name