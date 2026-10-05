select 
	pn.PopName
	,v.* 
from 
	vw_InboundShippingTotalsByPopulation as v
inner JOIN
	vw_popname as pn on v.PopulationID = pn.PopulationID
order by
	pn.PopName