/*
select Name,sum(amount) as TotalAmount,sum(amount*TonsEach/1000) as Totalkt, CostEach/TonsEach as CostPerTon  from vw_ComponentStockpiles group by Name 
--order by name
order by 3 desc
*/
select 
	cs.PopName
	,cs.Name as Component
	,cs.Amount * cs.TonsEach / 1000 as kTAvailable
	,round(ifnull(p.BPTotal * ip.Percentage/100 / cs.CostEach,0) * cs.TonsEach / 1000,1) as kTProducedPerYear
	,round(p.BPTotal / cs.CostEach * cs.TonsEach/1000,1) as MaxkTProducedPerYear
	,cs.Amount
	,cs.TonsEach
	,cs.CostEach
	,f.FleetName
	,mo.description as MoveOrder
	,ip.*
from  vw_ComponentStockpiles as cs
inner join vw_pop as p on p.PopulationID = cs.PopulationID
left join FCT_IndustrialProjects as ip on ip.PopulationID = cs.PopulationID and ip.ProductionType = 3 and ip.ProductionID = cs.SDComponentID
left join
	FCT_MoveOrders as mo
on
	mo.PopulationID = cs.PopulationID
AND
	mo.MoveActionID = 140
AND
	mo.DestinationItemID = cs.SDComponentID
left join fct_fleet as f on f.FleetID = mo.FleetID
where 
	cs.popname <> 'Prime'
AND	cs.popname not like 'BEG-A2M9 XENO'
--AND	cs.popname not like 'caa%'
--AND	cs.popname not like 'zzz-aast56%'
--AND cs.name like 'M-MP%'
--AND cs.name like 'C-MP%'
order by 
	cs.Amount * cs.TonsEach desc
	,
	cs.PopName
	, 
	mo.description
	, 
	cs.name
	
