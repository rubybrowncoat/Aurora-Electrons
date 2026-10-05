--create view vw_

SELECT
	p.PopName
	, pc.Amount
	,p.PopulationID
	, sdc.*
FROM
	FCT_PopComponent as pc
inner JOIN
	FCT_Population as p
on
	p.PopulationID = pc.PopulationID
inner JOIN	vw_const as c on c.RaceID = p.RaceID
inner JOIN
	FCT_ShipDesignComponents as sdc
on
	sdc.SDComponentID = pc.ComponentID
--where p.PopulationID in (17188,17418)
order by p.PopulationID, pc.ComponentID
	
	
--update FCT_PopComponent set PopulationID = 17188 where PopulationID = 17418 --and ComponentID <> 125825

--update FCT_PopComponent set Amount = Amount + 1 where PopulationID = 17188 and ComponentID = 125852

--delete from FCT_PopComponent where PopulationID = 17418 and ComponentID = 125852





--update FCT_PopComponent set PopulationID = 17221 where PopulationID = 17188 and ComponentID in (8, 126309, 126305, 126310, 18, 26265, 47485, 125992, 126001, 76181, 82471)



