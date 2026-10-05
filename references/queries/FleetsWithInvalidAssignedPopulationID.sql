select * from FCT_Fleet as f 
left join FCT_Population as p
on p.PopulationID = f.AssignedPopulationID
where p.PopulationID is null
and f.AssignedPopulationID <> 0